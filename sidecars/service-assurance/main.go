package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"
)

type artifactManifestFile struct {
	Path   string `json:"path"`
	SHA256 string `json:"sha256"`
}

type artifactSource struct {
	URI            string `json:"uri"`
	ManifestDigest string `json:"manifestDigest"`
	LayerDigest    string `json:"layerDigest"`
}

type artifactManifest struct {
	SchemaVersion int                    `json:"schemaVersion"`
	Artifact      string                 `json:"artifact"`
	Version       string                 `json:"version"`
	Source        artifactSource         `json:"source"`
	License       string                 `json:"license"`
	UpdatedAt     string                 `json:"updatedAt"`
	SHA256        string                 `json:"sha256"`
	Files         []artifactManifestFile `json:"files"`
	Signature     struct {
		Required  bool   `json:"required"`
		Algorithm string `json:"algorithm"`
	} `json:"signature"`
}

func newStrictDecoder(reader io.Reader) *json.Decoder {
	decoder := json.NewDecoder(reader)
	decoder.DisallowUnknownFields()
	decoder.UseNumber()
	return decoder
}

func environment(name string, fallback string) string {
	value := strings.TrimSpace(os.Getenv(name))
	if value == "" {
		return fallback
	}
	return value
}

func environmentInt(name string, fallback int) (int, error) {
	value := strings.TrimSpace(os.Getenv(name))
	if value == "" {
		return fallback, nil
	}
	parsed, err := strconv.Atoi(value)
	if err != nil || parsed <= 0 {
		return 0, fmt.Errorf("invalid numeric policy: %s", name)
	}
	return parsed, nil
}

func loadRuntimePolicyFromEnv() (RuntimePolicy, error) {
	maxRequests, err := environmentInt("SERVICE_ASSURANCE_MAX_REQUESTS", 200)
	if err != nil {
		return RuntimePolicy{}, err
	}
	maxConcurrency, err := environmentInt("SERVICE_ASSURANCE_MAX_CONCURRENCY", 4)
	if err != nil {
		return RuntimePolicy{}, err
	}
	requestTimeout, err := environmentInt("SERVICE_ASSURANCE_REQUEST_TIMEOUT_SECONDS", 10)
	if err != nil {
		return RuntimePolicy{}, err
	}
	totalTimeout, err := environmentInt("SERVICE_ASSURANCE_TOTAL_TIMEOUT_SECONDS", 120)
	if err != nil {
		return RuntimePolicy{}, err
	}
	maxResponseBytes, err := environmentInt("SERVICE_ASSURANCE_MAX_RESPONSE_BYTES", 1_048_576)
	if err != nil {
		return RuntimePolicy{}, err
	}
	policy := RuntimePolicy{
		Engine:                environment("SERVICE_ASSURANCE_ENGINE", ""),
		ListenAddress:         environment("SERVICE_ASSURANCE_LISTEN", ":8095"),
		NucleiBinary:          environment("SERVICE_ASSURANCE_NUCLEI_BINARY", "nuclei"),
		TrivyBinary:           environment("SERVICE_ASSURANCE_TRIVY_BINARY", "trivy"),
		ZapBinary:             environment("SERVICE_ASSURANCE_ZAP_BINARY", "zap-api-scan.py"),
		RulesRoot:             environment("SERVICE_ASSURANCE_RULES_ROOT", "/opt/service-assurance/rules"),
		VulnerabilityDBDir:    environment("SERVICE_ASSURANCE_VULNDB_ROOT", "/opt/service-assurance/vulndb"),
		WorkRoot:              environment("SERVICE_ASSURANCE_WORK_ROOT", "/tmp"),
		NucleiSafeTemplates:   []string{"nuclei/safe/http-security-headers.yaml", "nuclei/safe/triton-version-lead.yaml"},
		NucleiDeepTemplates:   []string{"nuclei/deep/openapi-authorization-readonly.yaml"},
		ZapSafeConfig:         "zap/safe.conf",
		ZapDeepConfig:         "zap/deep.conf",
		ZapDeepRuleIDs:        []string{"6", "40012", "40018"},
		MaxRequests:           maxRequests,
		MaxConcurrency:        maxConcurrency,
		RequestTimeoutSecs:    requestTimeout,
		TotalTimeoutSecs:      totalTimeout,
		MaxResponseBytes:      maxResponseBytes,
		EngineVersion:         environment("SERVICE_ASSURANCE_ENGINE_VERSION", ""),
		EngineDigest:          environment("SERVICE_ASSURANCE_ENGINE_DIGEST", ""),
		Baseline:              ArtifactBaseline{Version: environment("SERVICE_ASSURANCE_BASELINE_VERSION", ""), Digest: environment("SERVICE_ASSURANCE_BASELINE_DIGEST", "")},
		BaselineUpdatedAt:     environment("SERVICE_ASSURANCE_BASELINE_UPDATED_AT", ""),
		BaselineStatus:        environment("SERVICE_ASSURANCE_BASELINE_STATUS", "CURRENT"),
		ManifestPath:          environment("SERVICE_ASSURANCE_MANIFEST_PATH", ""),
		ManifestSignaturePath: environment("SERVICE_ASSURANCE_MANIFEST_SIGNATURE_PATH", ""),
		ManifestPublicKeyPath: environment("SERVICE_ASSURANCE_MANIFEST_PUBLIC_KEY_PATH", ""),
	}
	if err := validateRuntimePolicy(policy); err != nil {
		return RuntimePolicy{}, err
	}
	if err := verifyConfiguredManifest(policy); err != nil {
		return RuntimePolicy{}, err
	}
	return policy, nil
}

func validateRuntimePolicy(policy RuntimePolicy) error {
	if policy.Engine != "nuclei" && policy.Engine != "trivy" && policy.Engine != "zap" {
		return errors.New("unsupported sidecar engine")
	}
	if strings.TrimSpace(policy.ListenAddress) == "" ||
		strings.TrimSpace(policy.EngineVersion) == "" ||
		!validDigest(policy.EngineDigest) ||
		validateBaseline(policy.Baseline) != nil {
		return errors.New("sidecar version policy is incomplete")
	}
	if _, err := time.Parse(time.RFC3339, policy.BaselineUpdatedAt); err != nil {
		return errors.New("baseline update time is invalid")
	}
	if policy.BaselineStatus != "CURRENT" && policy.BaselineStatus != "STALE" {
		return errors.New("baseline status is invalid")
	}
	if policy.MaxRequests != 200 || policy.MaxConcurrency != 4 ||
		policy.RequestTimeoutSecs != 10 || policy.TotalTimeoutSecs != 120 ||
		policy.MaxResponseBytes != 1_048_576 {
		return errors.New("sidecar request budget must use the reviewed fixed policy")
	}
	for _, path := range append(
		append([]string{}, policy.NucleiSafeTemplates...),
		policy.NucleiDeepTemplates...,
	) {
		if _, err := safeArtifactPath(policy.RulesRoot, path); err != nil {
			return err
		}
	}
	if _, err := safeArtifactPath(policy.RulesRoot, policy.ZapSafeConfig); err != nil {
		return err
	}
	if _, err := safeArtifactPath(policy.RulesRoot, policy.ZapDeepConfig); err != nil {
		return err
	}
	return nil
}

func verifyConfiguredManifest(policy RuntimePolicy) error {
	if policy.ManifestPath == "" || policy.ManifestSignaturePath == "" ||
		policy.ManifestPublicKeyPath == "" {
		return errors.New("signed artifact manifest is required")
	}
	manifestBytes, err := os.ReadFile(policy.ManifestPath)
	if err != nil {
		return errors.New("artifact manifest is unavailable")
	}
	signature, err := os.ReadFile(policy.ManifestSignaturePath)
	if err != nil {
		return errors.New("artifact manifest signature is unavailable")
	}
	publicKey, err := os.ReadFile(policy.ManifestPublicKeyPath)
	if err != nil {
		return errors.New("artifact trust anchor is unavailable")
	}
	if err := verifyManifestSignature(manifestBytes, signature, publicKey); err != nil {
		return err
	}
	var manifest artifactManifest
	decoder := newStrictDecoder(strings.NewReader(string(manifestBytes)))
	if err := decoder.Decode(&manifest); err != nil {
		return errors.New("artifact manifest format is invalid")
	}
	var extra any
	if err := decoder.Decode(&extra); !errors.Is(err, io.EOF) {
		return errors.New("artifact manifest has trailing data")
	}
	if manifest.SchemaVersion != 1 || manifest.Version != policy.Baseline.Version ||
		manifest.SHA256 != policy.Baseline.Digest || !manifest.Signature.Required ||
		manifest.Signature.Algorithm != "rsa-sha256" ||
		strings.TrimSpace(manifest.License) == "" {
		return errors.New("artifact manifest does not match fixed baseline")
	}
	if err := validateArtifactSource(manifest.Source, policy.Engine == "trivy"); err != nil {
		return err
	}
	if _, err := time.Parse(time.RFC3339, manifest.UpdatedAt); err != nil ||
		manifest.UpdatedAt != policy.BaselineUpdatedAt {
		return errors.New("artifact manifest update time is invalid")
	}
	root := policy.RulesRoot
	if policy.Engine == "trivy" {
		root = policy.VulnerabilityDBDir
	}
	if err := verifyManifestFiles(root, manifest.Files); err != nil {
		return err
	}
	if aggregateManifestFiles(manifest.Files) != manifest.SHA256 {
		return errors.New("artifact aggregate digest mismatch")
	}
	return nil
}

func validateArtifactSource(source artifactSource, requirePinnedLayer bool) error {
	if strings.TrimSpace(source.URI) == "" {
		return errors.New("artifact source URI is required")
	}
	for _, digest := range []string{source.ManifestDigest, source.LayerDigest} {
		if digest != "" && !validDigest(digest) {
			return errors.New("artifact source digest is invalid")
		}
	}
	if requirePinnedLayer && (!validDigest(source.ManifestDigest) || !validDigest(source.LayerDigest)) {
		return errors.New("vulnerability database source must pin manifest and layer digests")
	}
	return nil
}

func verifyManifestFiles(root string, files []artifactManifestFile) error {
	if len(files) == 0 {
		return errors.New("artifact manifest has no files")
	}
	seen := make(map[string]bool, len(files))
	for _, item := range files {
		if seen[item.Path] || !validDigest(item.SHA256) {
			return errors.New("artifact manifest file entry is invalid")
		}
		seen[item.Path] = true
		path, err := safeArtifactPath(root, item.Path)
		if err != nil {
			return err
		}
		info, err := os.Lstat(path)
		if err != nil || !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 {
			return errors.New("artifact file is unavailable or not regular")
		}
		file, err := os.Open(path)
		if err != nil {
			return errors.New("artifact file cannot be opened")
		}
		hasher := sha256.New()
		_, copyErr := io.Copy(hasher, file)
		closeErr := file.Close()
		if copyErr != nil || closeErr != nil {
			return errors.New("artifact file cannot be hashed")
		}
		actual := "sha256:" + hex.EncodeToString(hasher.Sum(nil))
		if actual != item.SHA256 {
			return errors.New("artifact file digest mismatch")
		}
	}
	return nil
}

func aggregateManifestFiles(files []artifactManifestFile) string {
	sorted := append([]artifactManifestFile(nil), files...)
	sort.Slice(sorted, func(left, right int) bool {
		return sorted[left].Path < sorted[right].Path
	})
	hasher := sha256.New()
	for _, item := range sorted {
		_, _ = io.WriteString(hasher, item.Path)
		_, _ = hasher.Write([]byte{0})
		_, _ = io.WriteString(hasher, item.SHA256)
		_, _ = hasher.Write([]byte{'\n'})
	}
	return "sha256:" + hex.EncodeToString(hasher.Sum(nil))
}

func main() {
	log.SetFlags(log.Ldate | log.Ltime | log.LUTC)
	policy, err := loadRuntimePolicyFromEnv()
	if err != nil {
		log.Fatal("service assurance sidecar policy is not ready")
	}
	server := &http.Server{
		Addr:              policy.ListenAddress,
		Handler:           newSidecarServer(policy).handler(),
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       10 * time.Second,
		WriteTimeout:      time.Duration(policy.TotalTimeoutSecs+10) * time.Second,
		IdleTimeout:       30 * time.Second,
		MaxHeaderBytes:    16 * 1024,
	}
	log.Printf("service assurance sidecar listening engine=%s", policy.Engine)
	if err := server.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		log.Fatal("service assurance sidecar stopped")
	}
}

var _ = filepath.Separator
