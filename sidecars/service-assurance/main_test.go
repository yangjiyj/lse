package main

import (
	"bytes"
	"context"
	"crypto"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"encoding/hex"
	"encoding/json"
	"encoding/pem"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"
)

func testPolicy() RuntimePolicy {
	return RuntimePolicy{
		NucleiBinary:       "nuclei",
		TrivyBinary:        "trivy",
		ZapBinary:          "zap-api-scan.py",
		RulesRoot:          "/opt/service-assurance/rules",
		VulnerabilityDBDir: "/opt/service-assurance/vulndb",
		NucleiSafeTemplates: []string{
			"nuclei/safe/http-security-headers.yaml",
			"nuclei/safe/triton-version-lead.yaml",
		},
		NucleiDeepTemplates: []string{
			"nuclei/deep/openapi-authorization-readonly.yaml",
		},
		ZapSafeConfig:      "zap/safe.conf",
		ZapDeepConfig:      "zap/deep.conf",
		ZapDeepRuleIDs:     []string{"6", "40012", "40018"},
		MaxRequests:        200,
		MaxConcurrency:     4,
		RequestTimeoutSecs: 10,
		TotalTimeoutSecs:   120,
		MaxResponseBytes:   1_048_576,
	}
}

func testTarget() Target {
	return Target{
		URL:              "https://api.example.test/openapi.json",
		Hostname:         "api.example.test",
		PinnedAddress:    "93.184.216.34",
		AllowedAddresses: []string{"93.184.216.34"},
	}
}

func TestDecodeStrictJSONRejectsUnknownFieldsAndTrailingValues(t *testing.T) {
	body := strings.NewReader("{\"schemaVersion\":1,\"command\":\"sh\"}")
	var request NucleiRequest
	if err := decodeStrictJSON(body, 4096, &request); err == nil {
		t.Fatal("expected unknown command field to be rejected")
	}

	body = strings.NewReader("{\"schemaVersion\":1}{\"schemaVersion\":1}")
	if err := decodeStrictJSON(body, 4096, &request); err == nil {
		t.Fatal("expected trailing JSON value to be rejected")
	}
}

func TestBuildNucleiArgsPinsAddressAndUsesOnlyPackagedTemplates(t *testing.T) {
	policy := testPolicy()
	request := NucleiRequest{
		SchemaVersion: 1,
		Mode:          "SAFE",
		TargetKind:    "ENDPOINT",
		Target:        testTarget(),
		Budget:        requestBudgetFromPolicy(policy),
		Ruleset: ArtifactBaseline{
			Version: "lse-rules-2026.08.30",
			Digest:  "sha256:" + strings.Repeat("a", 64),
		},
		Authorization: Authorization{ActiveVerification: false},
	}

	args, err := buildNucleiArgs(request, policy)
	if err != nil {
		t.Fatal(err)
	}
	expected := []string{
		"-u", "https://93.184.216.34/openapi.json",
		"-H", "Host: api.example.test",
		"-sni", "api.example.test",
		"-jsonl", "-silent", "-no-color",
		"-disable-update-check", "-no-interactsh", "-disable-redirects",
		"-rl", "4", "-c", "2", "-timeout", "10",
		"-mhe", "5", "-rsr", "1048576",
		"-t", "/opt/service-assurance/rules/nuclei/safe/http-security-headers.yaml",
		"-t", "/opt/service-assurance/rules/nuclei/safe/triton-version-lead.yaml",
	}
	if !reflect.DeepEqual(args, expected) {
		t.Fatalf("unexpected args:\nwant %#v\n got %#v", expected, args)
	}
	joined := strings.Join(args, " ")
	for _, forbidden := range []string{
		"interactsh-url",
		"headless",
		"javascript",
		"code-template",
		"file-template",
		"fuzz",
	} {
		if strings.Contains(joined, forbidden) {
			t.Fatalf("forbidden nuclei capability in argv: %s", forbidden)
		}
	}
}

func TestBuildNucleiArgsRequiresAuthorizationForDeepTemplates(t *testing.T) {
	policy := testPolicy()
	request := NucleiRequest{
		SchemaVersion: 1,
		Mode:          "DEEP",
		TargetKind:    "OPENAPI",
		Target:        testTarget(),
		Budget:        requestBudgetFromPolicy(policy),
		Ruleset: ArtifactBaseline{
			Version: "lse-rules-2026.08.30",
			Digest:  "sha256:" + strings.Repeat("a", 64),
		},
		Authorization: Authorization{ActiveVerification: false},
	}
	if _, err := buildNucleiArgs(request, policy); err == nil {
		t.Fatal("expected deep scan without authorization to fail")
	}
	request.Authorization = Authorization{
		ActiveVerification: true,
		AuditDigest:        "sha256:" + strings.Repeat("b", 64),
	}
	args, err := buildNucleiArgs(request, policy)
	if err != nil {
		t.Fatal(err)
	}
	joined := strings.Join(args, " ")
	if !strings.Contains(joined, "/nuclei/deep/openapi-authorization-readonly.yaml") {
		t.Fatalf("deep allowlist template missing: %s", joined)
	}
	if !strings.Contains(joined, "/nuclei/safe/") {
		t.Fatalf("deep scan should use its reviewed allowlist only: %s", joined)
	}
}

func TestPrepareNucleiWorkspaceCreatesEmptyIgnoreFile(t *testing.T) {
	root := t.TempDir()
	if err := prepareNucleiWorkspace(root); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(root, "config", "nuclei", ".nuclei-ignore")
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if info.Size() != 0 || info.Mode().Perm() != 0o600 {
		t.Fatalf("unexpected ignore file: size=%d mode=%o", info.Size(), info.Mode().Perm())
	}
}

func TestBuildTrivyArgsIsOfflineAndUsesSidecarOwnedPaths(t *testing.T) {
	policy := testPolicy()
	content := "{\"bomFormat\":\"CycloneDX\",\"specVersion\":\"1.5\",\"components\":[]}"
	contentDigest := sha256.Sum256([]byte(content))
	request := TrivyRequest{
		SchemaVersion: 1,
		SBOM: SBOM{
			Format:        "CYCLONEDX_JSON",
			ContentSHA256: hex.EncodeToString(contentDigest[:]),
			Content:       content,
		},
		VulnerabilityDB: ArtifactBaseline{
			Version: "trivy-db-2026.05.22",
			Digest:  "sha256:" + strings.Repeat("d", 64),
		},
		Policy: TrivyPolicy{
			Offline:           true,
			SkipDBUpdate:      true,
			SkipJavaDBUpdate:  true,
			SkipVEXRepoUpdate: true,
			DisableTelemetry:  true,
			DetectionPriority: "precise",
		},
	}
	inputPath := "/tmp/service-assurance-run-1/input.cdx.json"
	args, err := buildTrivyArgs(request, policy, inputPath)
	if err != nil {
		t.Fatal(err)
	}
	expected := []string{
		"sbom", "--format", "json", "--scanners", "vuln",
		"--offline-scan", "--skip-db-update", "--skip-java-db-update",
		"--skip-vex-repo-update", "--detection-priority", "precise",
		"--cache-dir", "/opt/service-assurance/vulndb", "--quiet", inputPath,
	}
	if !reflect.DeepEqual(args, expected) {
		t.Fatalf("unexpected args:\nwant %#v\n got %#v", expected, args)
	}
}

func TestTrivyResponseCarriesAuditableAdvisoryQuery(t *testing.T) {
	record := trivyAdvisoryRecord{
		Ecosystem:          "maven",
		PackageName:        "org.apache.logging.log4j:log4j-core",
		PURL:               "pkg:maven/org.apache.logging.log4j/log4j-core@2.25.4",
		InstalledVersion:   "2.25.4",
		AdvisoryID:         "CVE-2021-44228",
		VulnerableVersions: []string{">=2.13.0, <2.15.0"},
		PatchedVersions:    []string{"2.15.0"},
		UnaffectedVersions: []string{},
		RecordSHA256:       "sha256:" + strings.Repeat("a", 64),
	}
	response := trivyResponse{
		SchemaVersion:          1,
		Completed:              true,
		AdvisoryQueryCompleted: true,
		AdvisoryRecords:        []trivyAdvisoryRecord{record},
		AdvisoryRecordsSHA256:  "sha256:" + strings.Repeat("b", 64),
	}
	encoded, err := json.Marshal(response)
	if err != nil {
		t.Fatal(err)
	}
	var contract map[string]any
	if err := json.Unmarshal(encoded, &contract); err != nil {
		t.Fatal(err)
	}
	if contract["advisoryQueryCompleted"] != true ||
		contract["advisoryRecordsSha256"] != response.AdvisoryRecordsSHA256 {
		t.Fatalf("advisory query contract missing: %s", encoded)
	}
	records, ok := contract["advisoryRecords"].([]any)
	if !ok || len(records) != 1 {
		t.Fatalf("advisory records missing: %s", encoded)
	}
}

func TestBuildZapArgsSeparatesSafeAndAuthorizedDeepModes(t *testing.T) {
	policy := testPolicy()
	safe := ZapRequest{
		SchemaVersion: 1,
		Mode:          "SAFE",
		TargetKind:    "OPENAPI",
		Target:        testTarget(),
		Budget:        requestBudgetFromPolicy(policy),
		Ruleset: ArtifactBaseline{
			Version: "lse-rules-2026.08.30",
			Digest:  "sha256:" + strings.Repeat("a", 64),
		},
		Authorization: Authorization{ActiveVerification: false},
		Policy: ZapPolicy{
			Format:        "openapi",
			SafeMode:      true,
			ActiveRuleIDs: []string{},
		},
	}
	outputPath := "/tmp/service-assurance-run-1/zap.json"
	gatewayTarget := "http://127.0.0.1:37191/openapi.json"
	args, err := buildZapArgs(safe, policy, gatewayTarget, outputPath)
	if err != nil {
		t.Fatal(err)
	}
	if !containsPair(args, "-t", gatewayTarget) {
		t.Fatalf("ZAP must import through the pinned target gateway: %#v", args)
	}
	if !containsPair(args, "-O", "http://127.0.0.1:37191") {
		t.Fatalf("ZAP must override every OpenAPI server with the guarded origin: %#v", args)
	}
	if strings.Contains(strings.Join(args, " "), safe.Target.PinnedAddress) {
		t.Fatalf("ZAP must not connect directly to the pinned address: %#v", args)
	}
	if !containsArg(args, "-S") {
		t.Fatalf("safe ZAP argv must contain -S: %#v", args)
	}
	if !containsPair(args, "-c", filepath.Join(policy.RulesRoot, policy.ZapSafeConfig)) {
		t.Fatalf("safe config missing: %#v", args)
	}
	if !containsPair(args, "-z", "-silent -dir /tmp/service-assurance-run-1/zap-home") {
		t.Fatalf("safe ZAP argv must use a fresh sidecar-owned home: %#v", args)
	}

	deep := safe
	deep.Mode = "DEEP"
	deep.Authorization = Authorization{
		ActiveVerification: true,
		AuditDigest:        "sha256:" + strings.Repeat("e", 64),
	}
	deep.Policy = ZapPolicy{
		Format:        "openapi",
		SafeMode:      false,
		ActiveRuleIDs: append([]string(nil), policy.ZapDeepRuleIDs...),
	}
	args, err = buildZapArgs(deep, policy, gatewayTarget, outputPath)
	if err != nil {
		t.Fatal(err)
	}
	if containsArg(args, "-S") {
		t.Fatalf("authorized deep ZAP argv must not contain -S: %#v", args)
	}
	if !containsPair(args, "-c", filepath.Join(policy.RulesRoot, policy.ZapDeepConfig)) {
		t.Fatalf("deep config missing: %#v", args)
	}
	if !containsPair(args, "-z", "-silent -dir /tmp/service-assurance-run-1/zap-home") {
		t.Fatalf("deep ZAP argv must use a fresh sidecar-owned home: %#v", args)
	}
	deep.Policy.ActiveRuleIDs = []string{"90000"}
	if _, err := buildZapArgs(deep, policy, gatewayTarget, outputPath); err == nil {
		t.Fatal("expected unreviewed active rule to be rejected")
	}
}

func TestPinnedTargetGatewayPreservesHTTPSHostAndSNI(t *testing.T) {
	hosts := make(chan string, 1)
	snis := make(chan string, 1)
	upstream := httptest.NewUnstartedServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		hosts <- request.Host
		response.Header().Set("content-type", "application/json")
		_, _ = io.WriteString(response, `{"openapi":"3.0.3","paths":{}}`)
	}))
	upstream.TLS = &tls.Config{
		MinVersion: tls.VersionTLS12,
		GetConfigForClient: func(hello *tls.ClientHelloInfo) (*tls.Config, error) {
			snis <- hello.ServerName
			return nil, nil
		},
	}
	upstream.StartTLS()
	defer upstream.Close()

	_, port, err := net.SplitHostPort(upstream.Listener.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	hostname := upstream.Certificate().DNSNames[0]
	target := Target{
		URL:              "https://" + net.JoinHostPort(hostname, port) + "/openapi.json",
		Hostname:         hostname,
		PinnedAddress:    "127.0.0.1",
		AllowedAddresses: []string{"127.0.0.1"},
	}
	roots := x509.NewCertPool()
	roots.AddCert(upstream.Certificate())
	gateway, err := startPinnedTargetGateway(context.Background(), target, testPolicy(), roots)
	if err != nil {
		t.Fatal(err)
	}
	defer gateway.Close()

	client := &http.Client{Timeout: 5 * time.Second}
	response, err := client.Get(gateway.TargetURL())
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		t.Fatalf("unexpected gateway status: %d", response.StatusCode)
	}
	if got := <-hosts; got != net.JoinHostPort(hostname, port) {
		t.Fatalf("upstream Host mismatch: want %s, got %s", net.JoinHostPort(hostname, port), got)
	}
	if got := <-snis; got != hostname {
		t.Fatalf("upstream SNI mismatch: want %s, got %s", hostname, got)
	}
}

func TestPinnedTargetGatewayBlocksRedirects(t *testing.T) {
	requests := 0
	upstream := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		requests++
		response.Header().Set("location", "http://169.254.169.254/latest/meta-data")
		response.WriteHeader(http.StatusFound)
	}))
	defer upstream.Close()
	targetURL, err := url.Parse(upstream.URL + "/openapi.json")
	if err != nil {
		t.Fatal(err)
	}
	target := Target{
		URL:              "http://redirect.example.test:" + targetURL.Port() + "/openapi.json",
		Hostname:         "redirect.example.test",
		PinnedAddress:    "127.0.0.1",
		AllowedAddresses: []string{"127.0.0.1"},
	}
	gateway, err := startPinnedTargetGateway(context.Background(), target, testPolicy(), nil)
	if err != nil {
		t.Fatal(err)
	}
	defer gateway.Close()

	response, err := (&http.Client{Timeout: 5 * time.Second}).Get(gateway.TargetURL())
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusBadGateway {
		t.Fatalf("redirect must be blocked, got status %d", response.StatusCode)
	}
	if response.Header.Get("location") != "" {
		t.Fatal("blocked redirect must not expose a followable Location header")
	}
	if requests != 1 || gateway.Err() == nil {
		t.Fatalf("redirect block was not recorded: requests=%d err=%v", requests, gateway.Err())
	}
}

func TestPinnedTargetGatewayEnforcesFixedRequestBudget(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		response.WriteHeader(http.StatusNoContent)
	}))
	defer upstream.Close()
	targetURL, err := url.Parse(upstream.URL + "/openapi.json")
	if err != nil {
		t.Fatal(err)
	}
	target := Target{
		URL:              "http://budget.example.test:" + targetURL.Port() + "/openapi.json",
		Hostname:         "budget.example.test",
		PinnedAddress:    "127.0.0.1",
		AllowedAddresses: []string{"127.0.0.1"},
	}
	policy := testPolicy()
	policy.MaxRequests = 1
	gateway, err := startPinnedTargetGateway(context.Background(), target, policy, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer gateway.Close()

	client := &http.Client{Timeout: 5 * time.Second}
	first, err := client.Get(gateway.TargetURL())
	if err != nil {
		t.Fatal(err)
	}
	first.Body.Close()
	second, err := client.Get(gateway.TargetURL())
	if err != nil {
		t.Fatal(err)
	}
	second.Body.Close()
	if first.StatusCode != http.StatusNoContent || second.StatusCode != http.StatusTooManyRequests {
		t.Fatalf("unexpected budget statuses: first=%d second=%d", first.StatusCode, second.StatusCode)
	}
	if gateway.Err() == nil {
		t.Fatal("budget exhaustion must mark the scan incomplete")
	}
}

func TestRewriteZapOutputTargetRestoresAuthorizedOrigin(t *testing.T) {
	raw := `{"site":[{"@name":"http://127.0.0.1:37191","@host":"127.0.0.1","@port":"37191","@ssl":"false","alerts":[{"instances":[{"uri":"http://127.0.0.1:37191/probe?q=1"}]}]}]}`
	rewritten, err := rewriteZapOutputTarget(raw, "http://127.0.0.1:37191", testTarget())
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(rewritten, "127.0.0.1:37191") {
		t.Fatalf("gateway address leaked into rewritten ZAP output: %s", rewritten)
	}
	var report struct {
		Site []struct {
			Name   string `json:"@name"`
			Host   string `json:"@host"`
			Port   string `json:"@port"`
			SSL    string `json:"@ssl"`
			Alerts []struct {
				Instances []struct {
					URI string `json:"uri"`
				} `json:"instances"`
			} `json:"alerts"`
		} `json:"site"`
	}
	if err := json.Unmarshal([]byte(rewritten), &report); err != nil {
		t.Fatal(err)
	}
	if len(report.Site) != 1 {
		t.Fatalf("unexpected rewritten report: %s", rewritten)
	}
	site := report.Site[0]
	if site.Name != "https://api.example.test" || site.Host != "api.example.test" ||
		site.Port != "443" || site.SSL != "true" ||
		site.Alerts[0].Instances[0].URI != "https://api.example.test/probe?q=1" {
		t.Fatalf("authorized origin was not restored: %#v", site)
	}
}

func TestVerifyManifestSignatureRejectsTampering(t *testing.T) {
	privateKey, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	publicDER, err := x509.MarshalPKIXPublicKey(&privateKey.PublicKey)
	if err != nil {
		t.Fatal(err)
	}
	publicPEM := pem.EncodeToMemory(&pem.Block{Type: "PUBLIC KEY", Bytes: publicDER})
	manifest := []byte("{\"schemaVersion\":1,\"version\":\"lse-rules-2026.08.30\"}")
	sum := sha256.Sum256(manifest)
	signature, err := rsa.SignPKCS1v15(rand.Reader, privateKey, crypto.SHA256, sum[:])
	if err != nil {
		t.Fatal(err)
	}
	if err := verifyManifestSignature(manifest, signature, publicPEM); err != nil {
		t.Fatalf("valid signature rejected: %v", err)
	}
	if err := verifyManifestSignature(append(manifest, '\n'), signature, publicPEM); err == nil {
		t.Fatal("tampered manifest signature should fail")
	}
}

func TestValidateArtifactSourceRequiresStructuredPinnedProvenance(t *testing.T) {
	dbSource := artifactSource{
		URI:            "ghcr.io/aquasecurity/trivy-db:2",
		ManifestDigest: "sha256:" + strings.Repeat("1", 64),
		LayerDigest:    "sha256:" + strings.Repeat("2", 64),
	}
	if err := validateArtifactSource(dbSource, true); err != nil {
		t.Fatalf("valid pinned DB source rejected: %v", err)
	}
	if err := validateArtifactSource(artifactSource{URI: "lse://service-assurance/rules"}, false); err != nil {
		t.Fatalf("local signed rules source rejected: %v", err)
	}
	dbSource.LayerDigest = ""
	if err := validateArtifactSource(dbSource, true); err == nil {
		t.Fatal("DB source without a pinned layer digest should fail")
	}
}

func TestArtifactPathsCannotEscapeReadOnlyRoots(t *testing.T) {
	root := "/opt/service-assurance/rules"
	path, err := safeArtifactPath(root, "nuclei/safe/http-security-headers.yaml")
	if err != nil {
		t.Fatal(err)
	}
	if path != "/opt/service-assurance/rules/nuclei/safe/http-security-headers.yaml" {
		t.Fatalf("unexpected path: %s", path)
	}
	for _, candidate := range []string{"../secret", "/etc/passwd", "nuclei/../../secret", ""} {
		if _, err := safeArtifactPath(root, candidate); err == nil {
			t.Fatalf("expected unsafe path to fail: %q", candidate)
		}
	}
}

func containsArg(args []string, expected string) bool {
	for _, arg := range args {
		if arg == expected {
			return true
		}
	}
	return false
}

func containsPair(args []string, key, value string) bool {
	for index := 0; index+1 < len(args); index++ {
		if args[index] == key && args[index+1] == value {
			return true
		}
	}
	return false
}

func TestRequestBudgetJSONShapeStaysStable(t *testing.T) {
	encoded, err := json.Marshal(requestBudgetFromPolicy(testPolicy()))
	if err != nil {
		t.Fatal(err)
	}
	expected := []byte("{\"maxRequests\":200,\"maxConcurrency\":4,\"requestTimeoutMs\":10000,\"totalTimeoutMs\":120000,\"maxResponseBytes\":1048576,\"maxRedirects\":0}")
	if !bytes.Equal(encoded, expected) {
		t.Fatalf("unexpected budget JSON: %s", encoded)
	}
}
