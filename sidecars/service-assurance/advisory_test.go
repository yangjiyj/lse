package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	bolt "go.etcd.io/bbolt"
)

func writeAdvisoryFixture(t *testing.T) string {
	t.Helper()
	dbPath := filepath.Join(t.TempDir(), "trivy.db")
	database, err := bolt.Open(dbPath, 0o600, nil)
	if err != nil {
		t.Fatal(err)
	}
	err = database.Update(func(tx *bolt.Tx) error {
		root, err := tx.CreateBucket([]byte("maven::GitHub Security Advisory Maven"))
		if err != nil {
			return err
		}
		component, err := root.CreateBucket([]byte("org.apache.logging.log4j:log4j-core"))
		if err != nil {
			return err
		}
		record := map[string]any{
			"VulnerableVersions": []string{">=2.13.0, <2.15.0", ">=2.4, <2.12.2"},
			"PatchedVersions":    []string{"2.15.0", "2.12.2"},
		}
		encoded, err := json.Marshal(record)
		if err != nil {
			return err
		}
		return component.Put([]byte("CVE-2021-44228"), encoded)
	})
	if err != nil {
		_ = database.Close()
		t.Fatal(err)
	}
	if err := database.Close(); err != nil {
		t.Fatal(err)
	}
	return dbPath
}

func writeOverflowingAdvisoryFixture(t *testing.T) string {
	t.Helper()
	dbPath := filepath.Join(t.TempDir(), "trivy.db")
	database, err := bolt.Open(dbPath, 0o600, nil)
	if err != nil {
		t.Fatal(err)
	}
	err = database.Update(func(tx *bolt.Tx) error {
		for source := 0; source < 2; source++ {
			root, err := tx.CreateBucket([]byte("maven::source-" + string(rune('a'+source))))
			if err != nil {
				return err
			}
			component, err := root.CreateBucket([]byte("org.example:component"))
			if err != nil {
				return err
			}
			ranges := make([]string, 0, 60)
			for index := 0; index < 60; index++ {
				ranges = append(ranges, ">="+string(rune('a'+source))+string(rune('A'+index)))
			}
			record := map[string]any{
				"VulnerableVersions": ranges,
				"PatchedVersions":    []string{"9.9.9"},
			}
			encoded, err := json.Marshal(record)
			if err != nil {
				return err
			}
			if err := component.Put([]byte("CVE-2026-9999"), encoded); err != nil {
				return err
			}
		}
		return nil
	})
	if err != nil {
		_ = database.Close()
		t.Fatal(err)
	}
	if err := database.Close(); err != nil {
		t.Fatal(err)
	}
	return dbPath
}

func trivyPackageOutput(purl, name, version string) string {
	value := map[string]any{
		"SchemaVersion": 2,
		"Results": []any{map[string]any{
			"Target": "Java",
			"Class":  "lang-pkgs",
			"Type":   "jar",
			"Packages": []any{map[string]any{
				"Name":       name,
				"Version":    version,
				"Identifier": map[string]any{"PURL": purl},
			}},
		}},
	}
	encoded, _ := json.Marshal(value)
	return string(encoded)
}

func TestQueryTrivyAdvisoriesBindsExactPackageToConcreteRanges(t *testing.T) {
	dbPath := writeAdvisoryFixture(t)
	output := trivyPackageOutput(
		"pkg:maven/org.apache.logging.log4j/log4j-core@2.25.4",
		"org.apache.logging.log4j:log4j-core",
		"2.25.4",
	)
	result, err := queryTrivyAdvisories(
		dbPath,
		output,
		"sha256:"+strings.Repeat("a", 64),
		100,
	)
	if err != nil {
		t.Fatal(err)
	}
	if !result.Completed || len(result.Records) != 1 {
		t.Fatalf("unexpected query result: %#v", result)
	}
	record := result.Records[0]
	if record.AdvisoryID != "CVE-2021-44228" ||
		record.PURL != "pkg:maven/org.apache.logging.log4j/log4j-core@2.25.4" ||
		record.InstalledVersion != "2.25.4" ||
		len(record.VulnerableVersions) == 0 ||
		len(record.PatchedVersions) == 0 ||
		!validDigest(record.RecordSHA256) ||
		!validDigest(result.RecordsSHA256) {
		t.Fatalf("concrete advisory evidence missing: %#v", result)
	}
}

func TestQueryTrivyAdvisoriesDoesNotInventUnknownOrUnsupportedCoverage(t *testing.T) {
	dbPath := writeAdvisoryFixture(t)
	unknown, err := queryTrivyAdvisories(
		dbPath,
		trivyPackageOutput(
			"pkg:maven/example.invalid/unknown@9.9.9",
			"example.invalid:unknown",
			"9.9.9",
		),
		"sha256:"+strings.Repeat("b", 64),
		100,
	)
	if err != nil {
		t.Fatal(err)
	}
	if !unknown.Completed || len(unknown.Records) != 0 {
		t.Fatalf("unknown Maven package must have no advisory conclusion: %#v", unknown)
	}

	unsupported, err := queryTrivyAdvisories(
		dbPath,
		trivyPackageOutput(
			"pkg:unsupported/example/component@1.0.0",
			"example:component",
			"1.0.0",
		),
		"sha256:"+strings.Repeat("c", 64),
		100,
	)
	if err != nil {
		t.Fatal(err)
	}
	if unsupported.Completed || len(unsupported.Records) != 0 {
		t.Fatalf("unsupported ecosystem must fail closed: %#v", unsupported)
	}
}

func TestQueryTrivyAdvisoriesFailsClosedWhenMergedRangesExceedBudget(t *testing.T) {
	result, err := queryTrivyAdvisories(
		writeOverflowingAdvisoryFixture(t),
		trivyPackageOutput(
			"pkg:maven/org.example/component@9.9.9",
			"org.example:component",
			"9.9.9",
		),
		"sha256:"+strings.Repeat("d", 64),
		100,
	)
	if err == nil || result.Completed || len(result.Records) != 0 {
		t.Fatalf("range budget overflow must fail closed: result=%#v err=%v", result, err)
	}
}

func TestIndexTrivyAdvisorySourcesGroupsSupportedBuckets(t *testing.T) {
	dbPath := filepath.Join(t.TempDir(), "trivy.db")
	database, err := bolt.Open(dbPath, 0o600, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer database.Close()
	if err := database.Update(func(tx *bolt.Tx) error {
		for _, name := range []string{
			"maven::GitHub Security Advisory Maven",
			"maven::Maven Security Archive",
			"npm::GitHub Security Advisory npm",
			"unrelated",
		} {
			if _, err := tx.CreateBucket([]byte(name)); err != nil {
				return err
			}
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if err := database.View(func(tx *bolt.Tx) error {
		sources, err := indexTrivyAdvisorySources(tx)
		if err != nil {
			return err
		}
		if len(sources["maven::"]) != 2 || len(sources["npm::"]) != 1 {
			t.Fatalf("supported source index is incomplete: %#v", sources)
		}
		if _, exists := sources["unrelated"]; exists {
			t.Fatalf("unsupported root must not enter source index: %#v", sources)
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
}

func TestVulnerabilityDBStatusUsesSignedMetadataExpiry(t *testing.T) {
	metadataPath := filepath.Join(t.TempDir(), "metadata.json")
	write := func(nextUpdate string) {
		t.Helper()
		content := []byte(`{"Version":2,"NextUpdate":"` + nextUpdate +
			`","UpdatedAt":"2026-08-30T07:05:29Z","DownloadedAt":"0001-01-01T00:00:00Z"}`)
		if err := os.WriteFile(metadataPath, content, 0o600); err != nil {
			t.Fatal(err)
		}
	}
	now := time.Date(2026, 8, 31, 7, 5, 29, 0, time.UTC)

	write("2026-08-31T07:05:30Z")
	status, err := vulnerabilityDBStatus(metadataPath, "CURRENT", now)
	if err != nil || status != "CURRENT" {
		t.Fatalf("fresh metadata rejected: status=%s err=%v", status, err)
	}

	write("2026-08-31T07:05:29Z")
	status, err = vulnerabilityDBStatus(metadataPath, "CURRENT", now)
	if err != nil || status != "STALE" {
		t.Fatalf("expired metadata must be stale: status=%s err=%v", status, err)
	}

	write("2026-09-01T07:05:29Z")
	status, err = vulnerabilityDBStatus(metadataPath, "STALE", now)
	if err != nil || status != "STALE" {
		t.Fatalf("configured stale baseline cannot be promoted: status=%s err=%v", status, err)
	}
}
