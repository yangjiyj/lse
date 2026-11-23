package main

import (
	"context"
	"encoding/json"
	"errors"
	"path/filepath"
	"strings"
	"time"
)

type executionCheck struct {
	ID           string `json:"id"`
	Label        string `json:"label"`
	Status       string `json:"status"`
	RequestCount *int64 `json:"requestCount"`
	Detail       string `json:"detail"`
}

type executionTelemetry struct {
	Checks       []executionCheck `json:"checks"`
	RequestCount *int64           `json:"requestCount"`
}

var nucleiCheckLabels = map[string]struct{ id, label string }{
	"http-security-headers.yaml":          {"lse-http-security-headers", "响应类型嗅探防护"},
	"triton-version-lead.yaml":            {"lse-triton-product-fingerprint", "Triton 服务识别"},
	"openapi-authorization-readonly.yaml": {"lse-unauthenticated-admin-status", "管理状态接口未授权访问"},
}

// Each invocation contains one reviewed, single-request HTTP template. The gateway
// observes successfully written upstream requests and completed responses, including negative
// matches. Process success or template count alone never proves execution.
func (server *sidecarServer) executeNucleiChecks(ctx context.Context, jobDir string, input NucleiRequest, args []string) (commandResult, executionTelemetry) {
	started := time.Now()
	result := commandResult{}
	execution := executionTelemetry{Checks: []executionCheck{}}
	baseArgs, templates := []string{}, []string{}
	for i := 0; i < len(args); i++ {
		if args[i] == "-t" && i+1 < len(args) {
			templates = append(templates, args[i+1])
			i++
			continue
		}
		baseArgs = append(baseArgs, args[i])
	}
	gateway, gatewayErr := startPinnedTargetGateway(ctx, input.Target, server.policy, nil)
	if gatewayErr == nil {
		defer gateway.Close()
	}
	output := &limitedBuffer{limit: maxToolOutputBytes}
	for _, template := range templates {
		identity, known := nucleiCheckLabels[filepath.Base(template)]
		if !known {
			identity.id = filepath.Base(template)
			identity.label = "固定安全检查"
		}
		check := executionCheck{ID: identity.id, Label: identity.label, Status: "UNKNOWN", Detail: "未取得该检查的请求执行证据。"}
		if gatewayErr != nil {
			check.Status = "FAILED"
			check.Detail = "核验目标连接未能建立。"
			result.err = gatewayErr
		} else if ctx.Err() != nil || result.err != nil {
			count := int64(0)
			check.RequestCount = &count
			check.Status = "SKIPPED"
			check.Detail = "前序检查失败或总执行时间已用尽，该项未执行。"
		} else {
			checkArgs := append([]string{}, baseArgs...)
			for i := 0; i+1 < len(checkArgs); i++ {
				if checkArgs[i] == "-u" {
					checkArgs[i+1] = gateway.TargetURL()
				}
			}
			checkArgs = append(checkArgs, "-t", template)
			before, responsesBefore := gateway.forwarded.Load(), gateway.responses.Load()
			current := executeTool(ctx, jobDir, server.policy.NucleiBinary, checkArgs, map[int]bool{0: true})
			count := gateway.forwarded.Load() - before
			responses := gateway.responses.Load() - responsesBefore
			check.RequestCount = &count
			if current.err == nil {
				current.err = gateway.Err()
			}
			rewritten, rewriteErr := rewriteNucleiOutputTarget(current.output, gateway.OriginURL(), input.Target)
			if current.err == nil {
				current.err = rewriteErr
			}
			if rewriteErr == nil {
				if _, err := output.Write([]byte(rewritten)); err != nil && current.err == nil {
					current.err = err
				}
			}
			if current.err != nil {
				check.Status = "FAILED"
				check.Detail = "检查执行失败，未形成完整结果。"
				result.err = current.err
			} else if known && count > 0 && responses == count {
				check.Status = "COMPLETED"
				check.Detail = "已观察到实际请求及完整响应，检查执行完成。"
			}
		}
		execution.Checks = append(execution.Checks, check)
	}
	if gateway != nil {
		count := gateway.forwarded.Load()
		execution.RequestCount = &count
	}
	result.output = output.String()
	result.duration = time.Since(started)
	return result, execution
}

// Scanner-generated locations and the request target/Host are restored before
// identity/evidence persistence. Response content is left intact.
func rewriteNucleiOutputTarget(raw, gatewayOrigin string, target Target) (string, error) {
	origin := target.URL
	// Target.URL may contain a path; retain only the original scheme/authority.
	_, authority, err := pinnedTargetURL(target)
	if err != nil {
		return "", err
	}
	scheme := strings.SplitN(target.URL, "://", 2)[0]
	origin = scheme + "://" + authority
	var output strings.Builder
	for _, line := range strings.Split(raw, "\n") {
		if strings.TrimSpace(line) == "" {
			continue
		}
		var event map[string]any
		if json.Unmarshal([]byte(line), &event) != nil || event == nil {
			return "", errors.New("invalid nuclei result")
		}
		for _, key := range []string{"host", "url", "matched-at"} {
			if value, ok := event[key].(string); ok && (value == gatewayOrigin || strings.HasPrefix(value, gatewayOrigin+"/") || strings.HasPrefix(value, gatewayOrigin+"?")) {
				event[key] = origin + strings.TrimPrefix(value, gatewayOrigin)
			}
		}
		if request, ok := event["request"].(string); ok {
			lines := strings.Split(request, "\n")
			for index, line := range lines {
				if index == 0 {
					lines[index] = strings.ReplaceAll(line, gatewayOrigin, origin)
				}
				if colon := strings.IndexByte(line, ':'); colon > 0 && strings.EqualFold(strings.TrimSpace(line[:colon]), "host") && strings.TrimSpace(line[colon+1:]) == strings.TrimPrefix(gatewayOrigin, "http://") {
					ending := ""
					if strings.HasSuffix(line, "\r") {
						ending = "\r"
					}
					lines[index] = "Host: " + authority + ending
				}
			}
			event["request"] = strings.Join(lines, "\n")
		}
		if _, ok := event["ip"]; ok {
			event["ip"] = target.PinnedAddress
		}
		encoded, err := json.Marshal(event)
		if err != nil {
			return "", errors.New("invalid nuclei result")
		}
		output.Write(encoded)
		output.WriteByte('\n')
	}
	return output.String(), nil
}
