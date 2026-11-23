package main

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
)

// Invoked as a child process by executeTool; uses only the loopback test target.
func TestNucleiProbeHelper(t *testing.T) {
	for i, arg := range os.Args {
		if arg != "-u" || i+1 >= len(os.Args) {
			continue
		}
		response, err := http.Get(os.Args[i+1])
		if err != nil {
			os.Exit(3)
		}
		_, _ = io.Copy(io.Discard, response.Body)
		_ = response.Body.Close()
		os.Exit(0)
	}
}

func TestNucleiTelemetryRequiresObservedRequests(t *testing.T) {
	var seen atomic.Int64
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seen.Add(1)
		w.WriteHeader(200)
	}))
	defer upstream.Close()
	parsed, _ := url.Parse(upstream.URL)
	target := Target{URL: upstream.URL, Hostname: parsed.Hostname(), PinnedAddress: "127.0.0.1", AllowedAddresses: []string{"127.0.0.1"}}
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	dir := t.TempDir()
	helper := filepath.Join(dir, "probe")
	script := "#!/bin/sh\nexec " + strconv.Quote(executable) + " -test.run=^TestNucleiProbeHelper$ -- \"$@\"\n"
	if err := os.WriteFile(helper, []byte(script), 0700); err != nil {
		t.Fatal(err)
	}
	args := []string{"-u", upstream.URL, "-t", "http-security-headers.yaml", "-t", "triton-version-lead.yaml"}
	policy := testPolicy()
	policy.NucleiBinary = helper
	server := newSidecarServer(policy)
	result, execution := server.executeNucleiChecks(context.Background(), dir, NucleiRequest{Target: target}, args)
	if result.err != nil {
		t.Fatal(result.err)
	}
	if seen.Load() != 2 || execution.RequestCount == nil || *execution.RequestCount != 2 {
		t.Fatalf("actual requests missing: %#v seen=%d", execution, seen.Load())
	}
	for _, check := range execution.Checks {
		if check.Status != "COMPLETED" || check.RequestCount == nil || *check.RequestCount != 1 {
			t.Fatalf("negative match must still have observed execution: %#v", check)
		}
	}
	server.policy.NucleiBinary = "/bin/true"
	result, execution = server.executeNucleiChecks(context.Background(), dir, NucleiRequest{Target: target}, args)
	if result.err != nil {
		t.Fatal(result.err)
	}
	for _, check := range execution.Checks {
		if check.Status != "UNKNOWN" || check.RequestCount == nil || *check.RequestCount != 0 {
			t.Fatalf("exit 0 without requests must remain unknown: %#v", check)
		}
	}
	server.policy.NucleiBinary = "/bin/false"
	result, execution = server.executeNucleiChecks(context.Background(), dir, NucleiRequest{Target: target}, args)
	if result.err == nil || execution.Checks[0].Status != "FAILED" || execution.Checks[1].Status != "SKIPPED" {
		t.Fatalf("failed process must not produce complete telemetry: %#v", execution)
	}
}

func TestNucleiTelemetryRejectsFailedUpstream(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Location", "http://outside.invalid")
		w.WriteHeader(302)
	}))
	defer upstream.Close()
	parsed, _ := url.Parse(upstream.URL)
	gateway, err := startPinnedTargetGateway(context.Background(), Target{URL: upstream.URL, Hostname: parsed.Hostname(), PinnedAddress: "127.0.0.1", AllowedAddresses: []string{"127.0.0.1"}}, testPolicy(), nil)
	if err != nil {
		t.Fatal(err)
	}
	defer gateway.Close()
	response, err := http.Get(gateway.TargetURL())
	if err != nil {
		t.Fatal(err)
	}
	_ = response.Body.Close()
	if gateway.forwarded.Load() != 1 || gateway.responses.Load() != 0 || gateway.Err() == nil {
		t.Fatal("redirect must not count as a completed response")
	}
}

func TestRewriteNucleiLocationsPreservesOriginalTarget(t *testing.T) {
	input := `{"host":"http://127.0.0.1:1234/api","matched-at":"http://127.0.0.1:1234/admin/status","ip":"127.0.0.1","request":"GET http://127.0.0.1:1234/admin/status HTTP/1.1\r\nHost: 127.0.0.1:1234\r\n","template-id":"lse-unauthenticated-admin-status","info":{"name":"Admin endpoint","severity":"high"}}`
	output, err := rewriteNucleiOutputTarget(input, "http://127.0.0.1:1234", testTarget())
	if err != nil || strings.Contains(output, "127.0.0.1") || !strings.Contains(output, "https://api.example.test/admin/status") {
		t.Fatalf("unexpected rewrite %s %v", output, err)
	}
	second, err := rewriteNucleiOutputTarget(strings.ReplaceAll(input, ":1234", ":4321"), "http://127.0.0.1:4321", testTarget())
	if err != nil || output != second {
		t.Fatalf("ephemeral gateway ports must not change persisted finding identity: %s / %s", output, second)
	}
	if !strings.Contains(output, "Host: api.example.test") {
		t.Fatal("request Host was not restored")
	}
	if _, err := rewriteNucleiOutputTarget("invalid", "http://127.0.0.1:1234", testTarget()); err == nil {
		t.Fatal("malformed scanner results must be rejected")
	}
}

func TestGatewayDoesNotCountRequestsThatWereNeverWritten(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(200) }))
	address := upstream.URL
	upstream.Close()
	parsed, _ := url.Parse(address)
	gateway, err := startPinnedTargetGateway(context.Background(), Target{URL: address, Hostname: parsed.Hostname(), PinnedAddress: "127.0.0.1", AllowedAddresses: []string{"127.0.0.1"}}, testPolicy(), nil)
	if err != nil {
		t.Fatal(err)
	}
	defer gateway.Close()
	response, err := http.Get(gateway.TargetURL())
	if err != nil {
		t.Fatal(err)
	}
	_ = response.Body.Close()
	if gateway.forwarded.Load() != 0 || gateway.responses.Load() != 0 || gateway.Err() == nil {
		t.Fatal("connection failures must not invent sent requests")
	}
}
