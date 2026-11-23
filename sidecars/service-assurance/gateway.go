package main

import (
	"bytes"
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"net/http/httptrace"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

var (
	errGatewayConcurrency = errors.New("pinned target gateway concurrency limit exceeded")
	errGatewayRedirect    = errors.New("pinned target gateway blocked a redirect")
	errGatewayRequestBody = errors.New("pinned target gateway request body exceeds fixed limit")
	errGatewayRequestCap  = errors.New("pinned target gateway request limit exceeded")
	errGatewayResponseCap = errors.New("pinned target gateway response exceeds fixed limit")
)

type pinnedTargetGateway struct {
	baseURL     string
	target      *url.URL
	authority   string
	policy      RuntimePolicy
	transport   *http.Transport
	server      *http.Server
	listener    net.Listener
	cancel      context.CancelFunc
	slots       chan struct{}
	requests    atomic.Int64
	forwarded   atomic.Int64
	responses   atomic.Int64
	closeOnce   sync.Once
	errMutex    sync.Mutex
	policyError error
}

func startPinnedTargetGateway(
	parent context.Context,
	target Target,
	policy RuntimePolicy,
	roots *x509.CertPool,
) (*pinnedTargetGateway, error) {
	pinnedURL, authority, err := pinnedTargetURL(target)
	if err != nil {
		return nil, err
	}
	upstream, err := url.Parse(pinnedURL)
	if err != nil {
		return nil, errors.New("invalid pinned upstream URL")
	}
	port := upstream.Port()
	if port == "" {
		if upstream.Scheme == "https" {
			port = "443"
		} else {
			port = "80"
		}
	}
	pinnedAddress := net.ParseIP(target.PinnedAddress)
	pinnedAuthority := net.JoinHostPort(pinnedAddress.String(), port)
	requestTimeout := time.Duration(policy.RequestTimeoutSecs) * time.Second
	dialer := &net.Dialer{Timeout: requestTimeout, KeepAlive: requestTimeout}
	transport := &http.Transport{
		Proxy: nil,
		DialContext: func(ctx context.Context, network, address string) (net.Conn, error) {
			host, requestedPort, err := net.SplitHostPort(address)
			if err != nil || requestedPort != port {
				return nil, errors.New("pinned target gateway rejected an unexpected connection")
			}
			requestedIP := net.ParseIP(host)
			if requestedIP == nil || !requestedIP.Equal(pinnedAddress) {
				return nil, errors.New("pinned target gateway rejected an unexpected address")
			}
			if _, _, err := pinnedTargetURL(target); err != nil {
				return nil, errors.New("pinned target gateway address is no longer authorized")
			}
			return dialer.DialContext(ctx, network, pinnedAuthority)
		},
		DisableCompression:    true,
		ForceAttemptHTTP2:     false,
		MaxConnsPerHost:       policy.MaxConcurrency,
		MaxIdleConnsPerHost:   policy.MaxConcurrency,
		ResponseHeaderTimeout: requestTimeout,
		TLSHandshakeTimeout:   requestTimeout,
		TLSClientConfig: &tls.Config{
			MinVersion: tls.VersionTLS12,
			RootCAs:    roots,
			ServerName: target.Hostname,
		},
	}
	listener, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		transport.CloseIdleConnections()
		return nil, errors.New("pinned target gateway is unavailable")
	}
	gatewayContext, cancel := context.WithCancel(parent)
	gateway := &pinnedTargetGateway{
		baseURL:   "http://" + listener.Addr().String(),
		target:    upstream,
		authority: authority,
		policy:    policy,
		transport: transport,
		listener:  listener,
		cancel:    cancel,
		slots:     make(chan struct{}, policy.MaxConcurrency),
	}
	gateway.server = &http.Server{
		Handler:           gateway,
		ReadHeaderTimeout: requestTimeout,
		ReadTimeout:       requestTimeout,
		WriteTimeout:      requestTimeout,
		IdleTimeout:       requestTimeout,
		MaxHeaderBytes:    64 * 1024,
	}
	go func() {
		<-gatewayContext.Done()
		_ = gateway.server.Close()
	}()
	go func() {
		err := gateway.server.Serve(listener)
		if err != nil && !errors.Is(err, http.ErrServerClosed) {
			gateway.recordError(errors.New("pinned target gateway stopped unexpectedly"))
		}
	}()
	return gateway, nil
}

func (gateway *pinnedTargetGateway) TargetURL() string {
	target := *gateway.target
	target.Scheme = "http"
	target.Host = strings.TrimPrefix(gateway.baseURL, "http://")
	return target.String()
}

func (gateway *pinnedTargetGateway) OriginURL() string {
	return gateway.baseURL
}

func (gateway *pinnedTargetGateway) Err() error {
	gateway.errMutex.Lock()
	defer gateway.errMutex.Unlock()
	return gateway.policyError
}

func (gateway *pinnedTargetGateway) Close() {
	gateway.closeOnce.Do(func() {
		gateway.cancel()
		_ = gateway.server.Close()
		gateway.transport.CloseIdleConnections()
	})
}

func (gateway *pinnedTargetGateway) ServeHTTP(response http.ResponseWriter, request *http.Request) {
	if request.Method == http.MethodConnect || request.URL.IsAbs() || request.RequestURI == "*" {
		gateway.reject(response, http.StatusBadRequest, errors.New("pinned target gateway rejected an invalid request"))
		return
	}
	if gateway.requests.Add(1) > int64(gateway.policy.MaxRequests) {
		gateway.reject(response, http.StatusTooManyRequests, errGatewayRequestCap)
		return
	}
	select {
	case gateway.slots <- struct{}{}:
		defer func() { <-gateway.slots }()
	default:
		gateway.reject(response, http.StatusTooManyRequests, errGatewayConcurrency)
		return
	}

	body, err := io.ReadAll(io.LimitReader(request.Body, int64(gateway.policy.MaxResponseBytes)+1))
	if err != nil || len(body) > gateway.policy.MaxResponseBytes {
		gateway.reject(response, http.StatusRequestEntityTooLarge, errGatewayRequestBody)
		return
	}
	upstreamURL := *gateway.target
	upstreamURL.Path = request.URL.Path
	upstreamURL.RawPath = request.URL.RawPath
	upstreamURL.RawQuery = request.URL.RawQuery
	upstreamURL.Fragment = ""
	ctx, cancel := context.WithTimeout(request.Context(), time.Duration(gateway.policy.RequestTimeoutSecs)*time.Second)
	defer cancel()
	upstreamRequest, err := http.NewRequestWithContext(ctx, request.Method, upstreamURL.String(), bytes.NewReader(body))
	if err != nil {
		gateway.reject(response, http.StatusBadGateway, errors.New("pinned target gateway could not construct the upstream request"))
		return
	}
	copyEndToEndHeaders(upstreamRequest.Header, request.Header)
	upstreamRequest.Host = gateway.authority
	upstreamRequest = upstreamRequest.WithContext(httptrace.WithClientTrace(upstreamRequest.Context(), &httptrace.ClientTrace{
		WroteRequest: func(info httptrace.WroteRequestInfo) {
			if info.Err == nil {
				gateway.forwarded.Add(1)
			}
		},
	}))
	upstreamResponse, err := gateway.transport.RoundTrip(upstreamRequest)
	if err != nil {
		gateway.reject(response, http.StatusBadGateway, errors.New("pinned target gateway upstream request failed"))
		return
	}
	defer upstreamResponse.Body.Close()
	if upstreamResponse.StatusCode >= 300 && upstreamResponse.StatusCode < 400 {
		_, _ = io.Copy(io.Discard, io.LimitReader(upstreamResponse.Body, 64*1024))
		gateway.reject(response, http.StatusBadGateway, errGatewayRedirect)
		return
	}
	responseBody, err := io.ReadAll(io.LimitReader(
		upstreamResponse.Body,
		int64(gateway.policy.MaxResponseBytes)+1,
	))
	if err != nil || len(responseBody) > gateway.policy.MaxResponseBytes {
		gateway.reject(response, http.StatusBadGateway, errGatewayResponseCap)
		return
	}
	gateway.responses.Add(1)
	copyEndToEndHeaders(response.Header(), upstreamResponse.Header)
	response.Header().Set("content-length", strconv.Itoa(len(responseBody)))
	response.WriteHeader(upstreamResponse.StatusCode)
	_, _ = response.Write(responseBody)
}

func (gateway *pinnedTargetGateway) reject(response http.ResponseWriter, status int, err error) {
	gateway.recordError(err)
	response.Header().Set("cache-control", "no-store")
	response.Header().Set("content-type", "text/plain; charset=utf-8")
	response.Header().Set("x-content-type-options", "nosniff")
	response.WriteHeader(status)
	_, _ = io.WriteString(response, "request blocked by service assurance policy")
}

func (gateway *pinnedTargetGateway) recordError(err error) {
	gateway.errMutex.Lock()
	defer gateway.errMutex.Unlock()
	if gateway.policyError == nil {
		gateway.policyError = err
	}
}

func copyEndToEndHeaders(destination, source http.Header) {
	for name, values := range source {
		switch strings.ToLower(name) {
		case "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
			"proxy-connection", "te", "trailer", "transfer-encoding", "upgrade":
			continue
		}
		for _, value := range values {
			destination.Add(name, value)
		}
	}
}

func rewriteZapOutputTarget(raw string, gatewayOrigin string, target Target) (string, error) {
	gatewayURL, err := url.Parse(gatewayOrigin)
	if err != nil || gatewayURL.Scheme != "http" || gatewayURL.Hostname() != "127.0.0.1" ||
		gatewayURL.Port() == "" || gatewayURL.Path != "" || gatewayURL.RawQuery != "" {
		return "", errors.New("invalid ZAP gateway origin")
	}
	originalURL, err := url.Parse(target.URL)
	if err != nil || originalURL.Scheme == "" || originalURL.Host == "" {
		return "", errors.New("invalid authorized ZAP origin")
	}
	decoder := json.NewDecoder(strings.NewReader(raw))
	decoder.UseNumber()
	var report any
	if err := decoder.Decode(&report); err != nil {
		return "", errors.New("invalid ZAP report JSON")
	}
	var trailing any
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		return "", errors.New("ZAP report JSON has trailing data")
	}
	originalPort := originalURL.Port()
	if originalPort == "" {
		if originalURL.Scheme == "https" {
			originalPort = "443"
		} else {
			originalPort = "80"
		}
	}
	rewriteZapReportValue(
		report,
		gatewayURL,
		originalURL.Scheme+"://"+originalURL.Host,
		originalURL.Hostname(),
		originalPort,
		originalURL.Scheme == "https",
	)
	encoded, err := json.Marshal(report)
	if err != nil {
		return "", errors.New("ZAP report JSON could not be encoded")
	}
	return string(encoded), nil
}

func rewriteZapReportValue(
	value any,
	gatewayURL *url.URL,
	originalOrigin string,
	originalHostname string,
	originalPort string,
	originalTLS bool,
) {
	switch typed := value.(type) {
	case map[string]any:
		gatewaySite, _ := typed["@host"].(string)
		isGatewaySite := gatewaySite == gatewayURL.Hostname()
		for key, item := range typed {
			if isGatewaySite {
				switch key {
				case "@host":
					typed[key] = originalHostname
					continue
				case "@port":
					typed[key] = originalPort
					continue
				case "@ssl":
					typed[key] = strconv.FormatBool(originalTLS)
					continue
				}
			}
			if text, ok := item.(string); ok && hasURLPrefix(text, gatewayURL.String()) {
				typed[key] = originalOrigin + strings.TrimPrefix(text, gatewayURL.String())
				continue
			}
			rewriteZapReportValue(
				item,
				gatewayURL,
				originalOrigin,
				originalHostname,
				originalPort,
				originalTLS,
			)
		}
	case []any:
		for _, item := range typed {
			rewriteZapReportValue(
				item,
				gatewayURL,
				originalOrigin,
				originalHostname,
				originalPort,
				originalTLS,
			)
		}
	}
}

func hasURLPrefix(value string, prefix string) bool {
	if value == prefix {
		return true
	}
	remaining := strings.TrimPrefix(value, prefix)
	return remaining != value && (strings.HasPrefix(remaining, "/") || strings.HasPrefix(remaining, "?"))
}
