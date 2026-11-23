package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

var (
	errToolOutputTooLarge         = errors.New("tool output exceeds fixed limit")
	errAdvisoryCoverageIncomplete = errors.New("advisory coverage is incomplete")
)

type limitedBuffer struct {
	buffer bytes.Buffer
	limit  int
}

func (writer *limitedBuffer) Write(value []byte) (int, error) {
	remaining := writer.limit - writer.buffer.Len()
	if remaining <= 0 {
		return 0, errToolOutputTooLarge
	}
	if len(value) > remaining {
		written, _ := writer.buffer.Write(value[:remaining])
		return written, errToolOutputTooLarge
	}
	return writer.buffer.Write(value)
}

func (writer *limitedBuffer) String() string {
	return writer.buffer.String()
}

type commandResult struct {
	output   string
	duration time.Duration
	err      error
}

func executeTool(
	ctx context.Context,
	workDir string,
	binary string,
	args []string,
	acceptedExitCodes map[int]bool,
) commandResult {
	started := time.Now()
	stdout := &limitedBuffer{limit: maxToolOutputBytes}
	stderr := &limitedBuffer{limit: 64 * 1024}
	command := exec.CommandContext(ctx, binary, args...)
	command.Dir = workDir
	command.Env = []string{
		"HOME=" + workDir,
		"LANG=C.UTF-8",
		"LC_ALL=C.UTF-8",
		"NO_PROXY=*",
		"PATH=/usr/local/bin:/usr/bin:/bin",
		"XDG_CACHE_HOME=" + filepath.Join(workDir, "cache"),
		"XDG_CONFIG_HOME=" + filepath.Join(workDir, "config"),
	}
	command.Stdout = stdout
	command.Stderr = stderr
	err := command.Run()
	if errors.Is(ctx.Err(), context.DeadlineExceeded) {
		err = context.DeadlineExceeded
	}
	if exitError := new(exec.ExitError); errors.As(err, &exitError) {
		if acceptedExitCodes[exitError.ExitCode()] {
			err = nil
		}
	}
	if errors.Is(err, errToolOutputTooLarge) ||
		strings.Contains(stderr.String(), errToolOutputTooLarge.Error()) {
		err = errToolOutputTooLarge
	}
	return commandResult{
		output:   stdout.String(),
		duration: time.Since(started),
		err:      err,
	}
}

func readFileLimited(path string, maximum int64) (string, error) {
	file, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer file.Close()
	reader := io.LimitReader(file, maximum+1)
	content, err := io.ReadAll(reader)
	if err != nil {
		return "", err
	}
	if int64(len(content)) > maximum {
		return "", errToolOutputTooLarge
	}
	return string(content), nil
}

type nucleiResponse struct {
	SchemaVersion    int                `json:"schemaVersion"`
	Completed        bool               `json:"completed"`
	OutputJSONL      string             `json:"outputJsonl"`
	Execution        executionTelemetry `json:"execution"`
	DurationMS       int64              `json:"durationMs"`
	RulesetVersion   string             `json:"rulesetVersion"`
	RulesetDigest    string             `json:"rulesetDigest"`
	RulesetUpdatedAt string             `json:"rulesetUpdatedAt"`
	RulesetStatus    string             `json:"rulesetStatus"`
	EngineVersion    string             `json:"engineVersion"`
	EngineDigest     string             `json:"engineDigest"`
	ErrorCode        *string            `json:"errorCode"`
	ErrorMessage     *string            `json:"errorMessage"`
}

type trivyResponse struct {
	SchemaVersion            int                   `json:"schemaVersion"`
	Completed                bool                  `json:"completed"`
	OutputJSON               string                `json:"outputJson"`
	DurationMS               int64                 `json:"durationMs"`
	VulnerabilityDBVersion   string                `json:"vulnerabilityDbVersion"`
	VulnerabilityDBDigest    string                `json:"vulnerabilityDbDigest"`
	VulnerabilityDBUpdatedAt string                `json:"vulnerabilityDbUpdatedAt"`
	VulnerabilityDBStatus    string                `json:"vulnerabilityDbStatus"`
	EngineVersion            string                `json:"engineVersion"`
	EngineDigest             string                `json:"engineDigest"`
	AdvisoryQueryCompleted   bool                  `json:"advisoryQueryCompleted"`
	AdvisoryRecords          []trivyAdvisoryRecord `json:"advisoryRecords"`
	AdvisoryRecordsSHA256    string                `json:"advisoryRecordsSha256"`
	ErrorCode                *string               `json:"errorCode"`
	ErrorMessage             *string               `json:"errorMessage"`
}

type zapResponse struct {
	Execution        executionTelemetry `json:"execution"`
	SchemaVersion    int                `json:"schemaVersion"`
	Completed        bool               `json:"completed"`
	OutputJSON       string             `json:"outputJson"`
	DurationMS       int64              `json:"durationMs"`
	RulesetVersion   string             `json:"rulesetVersion"`
	RulesetDigest    string             `json:"rulesetDigest"`
	RulesetUpdatedAt string             `json:"rulesetUpdatedAt"`
	RulesetStatus    string             `json:"rulesetStatus"`
	EngineVersion    string             `json:"engineVersion"`
	EngineDigest     string             `json:"engineDigest"`
	ErrorCode        *string            `json:"errorCode"`
	ErrorMessage     *string            `json:"errorMessage"`
}

type sidecarServer struct {
	policy RuntimePolicy
	slots  chan struct{}
}

func newSidecarServer(policy RuntimePolicy) *sidecarServer {
	return &sidecarServer{policy: policy, slots: make(chan struct{}, 1)}
}

func (server *sidecarServer) handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/healthz", server.handleHealth)
	mux.HandleFunc("/v1/nuclei/scan", server.handleNuclei)
	mux.HandleFunc("/v1/trivy/scan", server.handleTrivy)
	mux.HandleFunc("/v1/zap/scan", server.handleZap)
	return http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		response.Header().Set("cache-control", "no-store")
		response.Header().Set("x-content-type-options", "nosniff")
		mux.ServeHTTP(response, request)
	})
}

func (server *sidecarServer) handleHealth(response http.ResponseWriter, request *http.Request) {
	if request.Method != http.MethodGet {
		writeError(response, http.StatusMethodNotAllowed, "METHOD_NOT_ALLOWED")
		return
	}
	writeJSON(response, http.StatusOK, map[string]any{
		"status": "ok",
		"ready":  true,
	})
}

func (server *sidecarServer) acquire(response http.ResponseWriter) bool {
	select {
	case server.slots <- struct{}{}:
		return true
	default:
		writeError(response, http.StatusTooManyRequests, "SIDECAR_BUSY")
		return false
	}
}

func (server *sidecarServer) release() {
	<-server.slots
}

func (server *sidecarServer) validateScanRequest(
	response http.ResponseWriter,
	request *http.Request,
	engine string,
) bool {
	if request.Method != http.MethodPost {
		writeError(response, http.StatusMethodNotAllowed, "METHOD_NOT_ALLOWED")
		return false
	}
	if server.policy.Engine != engine {
		writeError(response, http.StatusNotFound, "ENDPOINT_NOT_AVAILABLE")
		return false
	}
	if !strings.HasPrefix(strings.ToLower(request.Header.Get("content-type")), "application/json") {
		writeError(response, http.StatusUnsupportedMediaType, "CONTENT_TYPE_INVALID")
		return false
	}
	return true
}

func (server *sidecarServer) createJobDir() (string, error) {
	root := server.policy.WorkRoot
	if root == "" {
		root = os.TempDir()
	}
	if err := os.MkdirAll(root, 0o700); err != nil {
		return "", err
	}
	return os.MkdirTemp(root, "service-assurance-")
}

func prepareNucleiWorkspace(workDir string) error {
	configDir := filepath.Join(workDir, "config", "nuclei")
	if err := os.MkdirAll(configDir, 0o700); err != nil {
		return err
	}
	return os.WriteFile(filepath.Join(configDir, ".nuclei-ignore"), nil, 0o600)
}

func (server *sidecarServer) handleNuclei(response http.ResponseWriter, request *http.Request) {
	if !server.validateScanRequest(response, request, "nuclei") || !server.acquire(response) {
		return
	}
	defer server.release()
	var input NucleiRequest
	if err := decodeStrictJSON(request.Body, maxRequestBodyBytes, &input); err != nil {
		writeError(response, http.StatusBadRequest, "REQUEST_INVALID")
		return
	}
	if input.Ruleset != server.policy.Baseline {
		writeError(response, http.StatusConflict, "BASELINE_MISMATCH")
		return
	}
	args, err := buildNucleiArgs(input, server.policy)
	if err != nil {
		writeError(response, http.StatusBadRequest, "POLICY_REJECTED")
		return
	}
	jobDir, err := server.createJobDir()
	if err != nil {
		writeError(response, http.StatusServiceUnavailable, "WORKSPACE_UNAVAILABLE")
		return
	}
	defer os.RemoveAll(jobDir)
	if err := prepareNucleiWorkspace(jobDir); err != nil {
		writeError(response, http.StatusServiceUnavailable, "WORKSPACE_UNAVAILABLE")
		return
	}
	ctx, cancel := context.WithTimeout(request.Context(), time.Duration(server.policy.TotalTimeoutSecs)*time.Second)
	defer cancel()
	result, execution := server.executeNucleiChecks(ctx, jobDir, input, args)
	code, message := safeToolFailure(result.err)
	writeJSON(response, http.StatusOK, nucleiResponse{
		SchemaVersion:    1,
		Completed:        result.err == nil,
		OutputJSONL:      result.output,
		Execution:        execution,
		DurationMS:       result.duration.Milliseconds(),
		RulesetVersion:   server.policy.Baseline.Version,
		RulesetDigest:    server.policy.Baseline.Digest,
		RulesetUpdatedAt: server.policy.BaselineUpdatedAt,
		RulesetStatus:    server.policy.BaselineStatus,
		EngineVersion:    server.policy.EngineVersion,
		EngineDigest:     server.policy.EngineDigest,
		ErrorCode:        code,
		ErrorMessage:     message,
	})
}

func (server *sidecarServer) handleTrivy(response http.ResponseWriter, request *http.Request) {
	if !server.validateScanRequest(response, request, "trivy") || !server.acquire(response) {
		return
	}
	defer server.release()
	var input TrivyRequest
	if err := decodeStrictJSON(request.Body, maxRequestBodyBytes, &input); err != nil {
		writeError(response, http.StatusBadRequest, "REQUEST_INVALID")
		return
	}
	if input.VulnerabilityDB != server.policy.Baseline {
		writeError(response, http.StatusConflict, "BASELINE_MISMATCH")
		return
	}
	metadataPath := filepath.Join(server.policy.VulnerabilityDBDir, "db", "metadata.json")
	_, metadataUpdatedAt, _, metadataErr := readVulnerabilityDBMetadata(metadataPath)
	databaseStatus, statusErr := vulnerabilityDBStatus(
		metadataPath,
		server.policy.BaselineStatus,
		time.Now().UTC(),
	)
	if metadataErr != nil || statusErr != nil {
		writeError(response, http.StatusServiceUnavailable, "BASELINE_NOT_READY")
		return
	}
	jobDir, err := server.createJobDir()
	if err != nil {
		writeError(response, http.StatusServiceUnavailable, "WORKSPACE_UNAVAILABLE")
		return
	}
	defer os.RemoveAll(jobDir)
	inputPath := filepath.Join(jobDir, "input.sbom")
	if err := os.WriteFile(inputPath, []byte(input.SBOM.Content), 0o600); err != nil {
		writeError(response, http.StatusServiceUnavailable, "WORKSPACE_UNAVAILABLE")
		return
	}
	args, err := buildTrivyArgs(input, server.policy, inputPath)
	if err != nil {
		writeError(response, http.StatusBadRequest, "POLICY_REJECTED")
		return
	}
	ctx, cancel := context.WithTimeout(request.Context(), time.Duration(server.policy.TotalTimeoutSecs)*time.Second)
	defer cancel()
	result := executeTool(ctx, jobDir, server.policy.TrivyBinary, args, map[int]bool{0: true})
	advisoryQuery := emptyTrivyAdvisoryQuery()
	if result.err == nil {
		advisoryQuery, err = queryTrivyAdvisories(
			filepath.Join(server.policy.VulnerabilityDBDir, "db", "trivy.db"),
			result.output,
			server.policy.Baseline.Digest,
			10_000,
		)
		if err != nil || !advisoryQuery.Completed {
			result.err = errAdvisoryCoverageIncomplete
			advisoryQuery = emptyTrivyAdvisoryQuery()
		}
	}
	code, message := safeToolFailure(result.err)
	writeJSON(response, http.StatusOK, trivyResponse{
		SchemaVersion:            1,
		Completed:                result.err == nil,
		OutputJSON:               result.output,
		DurationMS:               result.duration.Milliseconds(),
		VulnerabilityDBVersion:   server.policy.Baseline.Version,
		VulnerabilityDBDigest:    server.policy.Baseline.Digest,
		VulnerabilityDBUpdatedAt: metadataUpdatedAt.UTC().Format(time.RFC3339Nano),
		VulnerabilityDBStatus:    databaseStatus,
		EngineVersion:            server.policy.EngineVersion,
		EngineDigest:             server.policy.EngineDigest,
		AdvisoryQueryCompleted:   advisoryQuery.Completed,
		AdvisoryRecords:          advisoryQuery.Records,
		AdvisoryRecordsSHA256:    advisoryQuery.RecordsSHA256,
		ErrorCode:                code,
		ErrorMessage:             message,
	})
}

func (server *sidecarServer) handleZap(response http.ResponseWriter, request *http.Request) {
	if !server.validateScanRequest(response, request, "zap") || !server.acquire(response) {
		return
	}
	defer server.release()
	var input ZapRequest
	if err := decodeStrictJSON(request.Body, maxRequestBodyBytes, &input); err != nil {
		writeError(response, http.StatusBadRequest, "REQUEST_INVALID")
		return
	}
	if input.Ruleset != server.policy.Baseline {
		writeError(response, http.StatusConflict, "BASELINE_MISMATCH")
		return
	}
	jobDir, err := server.createJobDir()
	if err != nil {
		writeError(response, http.StatusServiceUnavailable, "WORKSPACE_UNAVAILABLE")
		return
	}
	defer os.RemoveAll(jobDir)
	outputPath := filepath.Join(jobDir, "zap-report.json")
	gateway, err := startPinnedTargetGateway(request.Context(), input.Target, server.policy, nil)
	if err != nil {
		writeError(response, http.StatusBadRequest, "POLICY_REJECTED")
		return
	}
	defer gateway.Close()
	args, err := buildZapArgs(input, server.policy, gateway.TargetURL(), outputPath)
	if err != nil {
		writeError(response, http.StatusBadRequest, "POLICY_REJECTED")
		return
	}
	ctx, cancel := context.WithTimeout(request.Context(), time.Duration(server.policy.TotalTimeoutSecs)*time.Second)
	defer cancel()
	result := executeTool(ctx, jobDir, server.policy.ZapBinary, args, map[int]bool{0: true, 1: true, 2: true})
	if gatewayErr := gateway.Err(); gatewayErr != nil && result.err == nil {
		result.err = gatewayErr
	}
	output, readErr := readFileLimited(outputPath, maxToolOutputBytes)
	if readErr != nil && result.err == nil {
		result.err = readErr
	}
	if readErr == nil && output != "" {
		rewritten, rewriteErr := rewriteZapOutputTarget(output, gateway.OriginURL(), input.Target)
		if rewriteErr != nil {
			output = ""
			if result.err == nil {
				result.err = rewriteErr
			}
		} else {
			output = rewritten
		}
	}
	count := gateway.forwarded.Load()
	execution := executionTelemetry{RequestCount: &count, Checks: []executionCheck{}}
	phaseIDs := []string{"zap-api-passive"}
	if input.Mode == "DEEP" {
		phaseIDs = append(phaseIDs, "zap-api-active")
	}
	for _, id := range phaseIDs {
		label := "接口描述与被动响应检查"
		if id == "zap-api-active" {
			label = "附加 API 主动检查"
		}
		status, detail := "UNKNOWN", "扫描进程已结束，但未取得该阶段逐规则执行证据；请求总数仅为网关实际观测。"
		if result.err != nil {
			status, detail = "FAILED", "接口检查未完整执行，无法确认该阶段的检查覆盖。"
		}
		execution.Checks = append(execution.Checks, executionCheck{ID: id, Label: label, Status: status, RequestCount: nil, Detail: detail})
	}
	code, message := safeToolFailure(result.err)
	writeJSON(response, http.StatusOK, zapResponse{
		Execution:        execution,
		SchemaVersion:    1,
		Completed:        result.err == nil,
		OutputJSON:       output,
		DurationMS:       result.duration.Milliseconds(),
		RulesetVersion:   server.policy.Baseline.Version,
		RulesetDigest:    server.policy.Baseline.Digest,
		RulesetUpdatedAt: server.policy.BaselineUpdatedAt,
		RulesetStatus:    server.policy.BaselineStatus,
		EngineVersion:    server.policy.EngineVersion,
		EngineDigest:     server.policy.EngineDigest,
		ErrorCode:        code,
		ErrorMessage:     message,
	})
}

func safeToolFailure(err error) (*string, *string) {
	if err == nil {
		return nil, nil
	}
	code := "SERVICE_ASSURANCE_ENGINE_FAILED"
	message := "核验未完整执行，覆盖不完整。"
	if errors.Is(err, context.DeadlineExceeded) {
		code = "SERVICE_ASSURANCE_ENGINE_TIMEOUT"
		message = "核验执行超时，覆盖不完整。"
	} else if errors.Is(err, errToolOutputTooLarge) {
		code = "SERVICE_ASSURANCE_OUTPUT_TOO_LARGE"
		message = "核验输出超过固定限制，覆盖不完整。"
	} else if errors.Is(err, errAdvisoryCoverageIncomplete) {
		code = "SERVICE_ASSURANCE_ADVISORY_COVERAGE_INCOMPLETE"
		message = "组件公告核验未完整执行，覆盖不完整。"
	}
	return &code, &message
}

func writeError(response http.ResponseWriter, status int, code string) {
	writeJSON(response, status, map[string]string{
		"code":    code,
		"message": "安全核验请求未执行。",
	})
}

func writeJSON(response http.ResponseWriter, status int, value any) {
	response.Header().Set("content-type", "application/json; charset=utf-8")
	response.WriteHeader(status)
	if err := json.NewEncoder(response).Encode(value); err != nil {
		_, _ = fmt.Fprint(io.Discard, err)
	}
}
