package main

import (
	"crypto"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/x509"
	"encoding/hex"
	"encoding/pem"
	"errors"
	"fmt"
	"io"
	"net"
	"net/url"
	"path/filepath"
	"strconv"
	"strings"
)

const (
	maxRequestBodyBytes = 20 * 1024 * 1024
	maxToolOutputBytes  = 16 * 1024 * 1024
)

type Target struct {
	URL              string   `json:"url"`
	Hostname         string   `json:"hostname"`
	PinnedAddress    string   `json:"pinnedAddress"`
	AllowedAddresses []string `json:"allowedAddresses"`
}

type RequestBudget struct {
	MaxRequests      int `json:"maxRequests"`
	MaxConcurrency   int `json:"maxConcurrency"`
	RequestTimeoutMS int `json:"requestTimeoutMs"`
	TotalTimeoutMS   int `json:"totalTimeoutMs"`
	MaxResponseBytes int `json:"maxResponseBytes"`
	MaxRedirects     int `json:"maxRedirects"`
}

type ArtifactBaseline struct {
	Version string `json:"version"`
	Digest  string `json:"digest"`
}

type Authorization struct {
	ActiveVerification bool   `json:"activeVerification"`
	AuditDigest        string `json:"auditDigest,omitempty"`
}

type NucleiRequest struct {
	SchemaVersion int              `json:"schemaVersion"`
	Mode          string           `json:"mode"`
	TargetKind    string           `json:"targetKind"`
	Target        Target           `json:"target"`
	Budget        RequestBudget    `json:"budget"`
	Ruleset       ArtifactBaseline `json:"ruleset"`
	Authorization Authorization    `json:"authorization"`
}

type SBOM struct {
	Format        string `json:"format"`
	ContentSHA256 string `json:"contentSha256"`
	Content       string `json:"content"`
}

type TrivyPolicy struct {
	Offline           bool   `json:"offline"`
	SkipDBUpdate      bool   `json:"skipDbUpdate"`
	SkipJavaDBUpdate  bool   `json:"skipJavaDbUpdate"`
	SkipVEXRepoUpdate bool   `json:"skipVexRepoUpdate"`
	DisableTelemetry  bool   `json:"disableTelemetry"`
	DetectionPriority string `json:"detectionPriority"`
}

type TrivyRequest struct {
	SchemaVersion   int              `json:"schemaVersion"`
	SBOM            SBOM             `json:"sbom"`
	VulnerabilityDB ArtifactBaseline `json:"vulnerabilityDb"`
	Policy          TrivyPolicy      `json:"policy"`
}

type ZapPolicy struct {
	Format        string   `json:"format"`
	SafeMode      bool     `json:"safeMode"`
	ActiveRuleIDs []string `json:"activeRuleIds"`
}

type ZapRequest struct {
	SchemaVersion int              `json:"schemaVersion"`
	Mode          string           `json:"mode"`
	TargetKind    string           `json:"targetKind"`
	Target        Target           `json:"target"`
	Budget        RequestBudget    `json:"budget"`
	Ruleset       ArtifactBaseline `json:"ruleset"`
	Authorization Authorization    `json:"authorization"`
	Policy        ZapPolicy        `json:"policy"`
}

type RuntimePolicy struct {
	Engine                string
	ListenAddress         string
	NucleiBinary          string
	TrivyBinary           string
	ZapBinary             string
	RulesRoot             string
	VulnerabilityDBDir    string
	WorkRoot              string
	NucleiSafeTemplates   []string
	NucleiDeepTemplates   []string
	ZapSafeConfig         string
	ZapDeepConfig         string
	ZapDeepRuleIDs        []string
	MaxRequests           int
	MaxConcurrency        int
	RequestTimeoutSecs    int
	TotalTimeoutSecs      int
	MaxResponseBytes      int
	EngineVersion         string
	EngineDigest          string
	Baseline              ArtifactBaseline
	BaselineUpdatedAt     string
	BaselineStatus        string
	ManifestPath          string
	ManifestSignaturePath string
	ManifestPublicKeyPath string
}

func decodeStrictJSON(reader io.Reader, maximum int64, destination any) error {
	limited := io.LimitReader(reader, maximum+1)
	decoder := newStrictDecoder(limited)
	if err := decoder.Decode(destination); err != nil {
		return fmt.Errorf("invalid JSON request: %w", err)
	}
	if decoder.InputOffset() > maximum {
		return errors.New("JSON request exceeds size limit")
	}
	var extra any
	if err := decoder.Decode(&extra); !errors.Is(err, io.EOF) {
		if err == nil {
			return errors.New("JSON request has trailing value")
		}
		return fmt.Errorf("invalid trailing JSON: %w", err)
	}
	return nil
}

func requestBudgetFromPolicy(policy RuntimePolicy) RequestBudget {
	return RequestBudget{
		MaxRequests:      policy.MaxRequests,
		MaxConcurrency:   policy.MaxConcurrency,
		RequestTimeoutMS: policy.RequestTimeoutSecs * 1000,
		TotalTimeoutMS:   policy.TotalTimeoutSecs * 1000,
		MaxResponseBytes: policy.MaxResponseBytes,
		MaxRedirects:     0,
	}
}

func validateBudget(actual RequestBudget, policy RuntimePolicy) error {
	expected := requestBudgetFromPolicy(policy)
	if actual != expected {
		return errors.New("request budget does not match fixed sidecar policy")
	}
	return nil
}

func validateBaseline(value ArtifactBaseline) error {
	if strings.TrimSpace(value.Version) == "" || !validDigest(value.Digest) {
		return errors.New("invalid artifact baseline")
	}
	return nil
}

func validDigest(value string) bool {
	if !strings.HasPrefix(value, "sha256:") || len(value) != 71 {
		return false
	}
	_, err := hex.DecodeString(strings.TrimPrefix(value, "sha256:"))
	return err == nil
}

func validateAuthorization(value Authorization, required bool) error {
	if !required {
		if value.ActiveVerification || value.AuditDigest != "" {
			return errors.New("safe mode cannot carry active authorization")
		}
		return nil
	}
	if !value.ActiveVerification || !validDigest(value.AuditDigest) {
		return errors.New("deep mode requires an authorization audit digest")
	}
	return nil
}

func safeArtifactPath(root string, relative string) (string, error) {
	if strings.TrimSpace(root) == "" || strings.TrimSpace(relative) == "" ||
		filepath.IsAbs(relative) {
		return "", errors.New("invalid artifact path")
	}
	clean := filepath.Clean(relative)
	if clean == "." || clean == ".." || strings.HasPrefix(clean, ".."+string(filepath.Separator)) {
		return "", errors.New("artifact path escapes root")
	}
	joined := filepath.Join(root, clean)
	rel, err := filepath.Rel(root, joined)
	if err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
		return "", errors.New("artifact path escapes root")
	}
	return joined, nil
}

func verifyManifestSignature(manifest, signature, publicKeyPEM []byte) error {
	block, rest := pem.Decode(publicKeyPEM)
	if block == nil || len(rest) != 0 || block.Type != "PUBLIC KEY" {
		return errors.New("invalid manifest public key")
	}
	parsed, err := x509.ParsePKIXPublicKey(block.Bytes)
	if err != nil {
		return fmt.Errorf("parse manifest public key: %w", err)
	}
	publicKey, ok := parsed.(*rsa.PublicKey)
	if !ok || publicKey.N.BitLen() < 2048 {
		return errors.New("manifest public key must be RSA 2048 or stronger")
	}
	sum := sha256.Sum256(manifest)
	if err := rsa.VerifyPKCS1v15(publicKey, crypto.SHA256, sum[:], signature); err != nil {
		return errors.New("manifest signature verification failed")
	}
	return nil
}

func pinnedTargetURL(target Target) (string, string, error) {
	parsed, err := url.Parse(target.URL)
	if err != nil || (parsed.Scheme != "http" && parsed.Scheme != "https") ||
		parsed.User != nil || parsed.Fragment != "" {
		return "", "", errors.New("invalid scanner target")
	}
	if !strings.EqualFold(parsed.Hostname(), target.Hostname) {
		return "", "", errors.New("target hostname mismatch")
	}
	pinned := net.ParseIP(target.PinnedAddress)
	if pinned == nil {
		return "", "", errors.New("invalid pinned target address")
	}
	allowed := false
	for _, candidate := range target.AllowedAddresses {
		address := net.ParseIP(candidate)
		if address == nil {
			return "", "", errors.New("invalid allowed target address")
		}
		if address.Equal(pinned) {
			allowed = true
		}
	}
	if !allowed {
		return "", "", errors.New("pinned target is outside allowed addresses")
	}
	originalHost := parsed.Host
	if port := parsed.Port(); port != "" {
		parsed.Host = net.JoinHostPort(pinned.String(), port)
	} else if pinned.To4() == nil {
		parsed.Host = "[" + pinned.String() + "]"
	} else {
		parsed.Host = pinned.String()
	}
	return parsed.String(), originalHost, nil
}

func buildNucleiArgs(request NucleiRequest, policy RuntimePolicy) ([]string, error) {
	if request.SchemaVersion != 1 || (request.Mode != "SAFE" && request.Mode != "DEEP") ||
		request.TargetKind == "SBOM" {
		return nil, errors.New("unsupported nuclei request")
	}
	if err := validateBudget(request.Budget, policy); err != nil {
		return nil, err
	}
	if err := validateBaseline(request.Ruleset); err != nil {
		return nil, err
	}
	deep := request.Mode == "DEEP"
	if err := validateAuthorization(request.Authorization, deep); err != nil {
		return nil, err
	}
	targetURL, hostHeader, err := pinnedTargetURL(request.Target)
	if err != nil {
		return nil, err
	}
	args := []string{
		"-u", targetURL,
		"-H", "Host: " + hostHeader,
		"-sni", request.Target.Hostname,
		"-jsonl", "-silent", "-no-color",
		"-disable-update-check", "-no-interactsh", "-disable-redirects",
		"-rl", "4", "-c", "2",
		"-timeout", strconv.Itoa(policy.RequestTimeoutSecs),
		"-mhe", "5",
		"-rsr", strconv.Itoa(policy.MaxResponseBytes),
	}
	templates := policy.NucleiSafeTemplates
	if deep {
		templates = append(append([]string{}, policy.NucleiSafeTemplates...), policy.NucleiDeepTemplates...)
	}
	if len(templates) == 0 {
		return nil, errors.New("no reviewed nuclei templates configured")
	}
	for _, template := range templates {
		path, err := safeArtifactPath(policy.RulesRoot, template)
		if err != nil {
			return nil, err
		}
		args = append(args, "-t", path)
	}
	return args, nil
}

func buildTrivyArgs(request TrivyRequest, policy RuntimePolicy, inputPath string) ([]string, error) {
	if request.SchemaVersion != 1 ||
		(request.SBOM.Format != "CYCLONEDX_JSON" &&
			request.SBOM.Format != "SPDX_JSON" &&
			request.SBOM.Format != "SPDX_TAG_VALUE") {
		return nil, errors.New("unsupported SBOM request")
	}
	if err := validateBaseline(request.VulnerabilityDB); err != nil {
		return nil, err
	}
	if !request.Policy.Offline || !request.Policy.SkipDBUpdate ||
		!request.Policy.SkipJavaDBUpdate || !request.Policy.SkipVEXRepoUpdate ||
		!request.Policy.DisableTelemetry || request.Policy.DetectionPriority != "precise" {
		return nil, errors.New("trivy request violates offline policy")
	}
	sum := sha256.Sum256([]byte(request.SBOM.Content))
	if hex.EncodeToString(sum[:]) != request.SBOM.ContentSHA256 {
		return nil, errors.New("SBOM digest mismatch")
	}
	if !filepath.IsAbs(inputPath) || strings.TrimSpace(inputPath) == "" {
		return nil, errors.New("invalid sidecar input path")
	}
	return []string{
		"sbom", "--format", "json", "--scanners", "vuln",
		"--offline-scan", "--skip-db-update", "--skip-java-db-update",
		"--skip-vex-repo-update", "--detection-priority", "precise",
		"--cache-dir", policy.VulnerabilityDBDir, "--quiet", inputPath,
	}, nil
}

func buildZapArgs(
	request ZapRequest,
	policy RuntimePolicy,
	gatewayTarget string,
	outputPath string,
) ([]string, error) {
	if request.SchemaVersion != 1 || request.TargetKind != "OPENAPI" ||
		(request.Mode != "SAFE" && request.Mode != "DEEP") ||
		request.Policy.Format != "openapi" {
		return nil, errors.New("unsupported ZAP request")
	}
	if err := validateBudget(request.Budget, policy); err != nil {
		return nil, err
	}
	if err := validateBaseline(request.Ruleset); err != nil {
		return nil, err
	}
	deep := request.Mode == "DEEP"
	if err := validateAuthorization(request.Authorization, deep); err != nil {
		return nil, err
	}
	if _, _, err := pinnedTargetURL(request.Target); err != nil {
		return nil, err
	}
	gatewayURL, err := url.Parse(gatewayTarget)
	if err != nil || gatewayURL.Scheme != "http" ||
		gatewayURL.Hostname() != "127.0.0.1" || gatewayURL.Port() == "" ||
		gatewayURL.User != nil || gatewayURL.Fragment != "" {
		return nil, errors.New("invalid guarded ZAP target")
	}
	if !filepath.IsAbs(outputPath) || strings.TrimSpace(outputPath) == "" {
		return nil, errors.New("invalid sidecar output path")
	}
	config := policy.ZapSafeConfig
	if deep {
		config = policy.ZapDeepConfig
		if request.Policy.SafeMode || !equalStrings(request.Policy.ActiveRuleIDs, policy.ZapDeepRuleIDs) {
			return nil, errors.New("ZAP active rule allowlist mismatch")
		}
	} else if !request.Policy.SafeMode || len(request.Policy.ActiveRuleIDs) != 0 {
		return nil, errors.New("safe ZAP mode cannot enable active rules")
	}
	configPath, err := safeArtifactPath(policy.RulesRoot, config)
	if err != nil {
		return nil, err
	}
	minutes := policy.TotalTimeoutSecs / 60
	if minutes < 1 {
		minutes = 1
	}
	args := []string{
		"-t", gatewayURL.String(),
		"-f", "openapi",
		"-O", gatewayURL.Scheme + "://" + gatewayURL.Host,
		"-J", outputPath,
		"-c", configPath,
		"-T", strconv.Itoa(minutes),
		"-z", "-silent -dir " + filepath.Join(filepath.Dir(outputPath), "zap-home"),
	}
	if !deep {
		args = append(args, "-S")
	}
	return args, nil
}

func equalStrings(left, right []string) bool {
	if len(left) != len(right) {
		return false
	}
	for index := range left {
		if left[index] != right[index] {
			return false
		}
	}
	return true
}
