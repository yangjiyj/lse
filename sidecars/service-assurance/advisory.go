package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	bolt "go.etcd.io/bbolt"
)

const (
	maxAdvisoryRanges = 100
	maxAdvisoryText   = 2_000
)

type trivyAdvisoryRecord struct {
	Ecosystem          string   `json:"ecosystem"`
	PackageName        string   `json:"packageName"`
	PURL               string   `json:"purl"`
	InstalledVersion   string   `json:"installedVersion"`
	AdvisoryID         string   `json:"advisoryId"`
	VulnerableVersions []string `json:"vulnerableVersions"`
	PatchedVersions    []string `json:"patchedVersions"`
	UnaffectedVersions []string `json:"unaffectedVersions"`
	RecordSHA256       string   `json:"recordSha256"`
}

type trivyAdvisoryQueryResult struct {
	Completed     bool                  `json:"advisoryQueryCompleted"`
	Records       []trivyAdvisoryRecord `json:"advisoryRecords"`
	RecordsSHA256 string                `json:"advisoryRecordsSha256"`
}

type rawTrivyAdvisory struct {
	VulnerableVersions []string `json:"VulnerableVersions"`
	PatchedVersions    []string `json:"PatchedVersions"`
	UnaffectedVersions []string `json:"UnaffectedVersions"`
}

type trivyDBMetadata struct {
	Version      int    `json:"Version"`
	NextUpdate   string `json:"NextUpdate"`
	UpdatedAt    string `json:"UpdatedAt"`
	DownloadedAt string `json:"DownloadedAt"`
}

type scannedTrivyPackage struct {
	Name      string
	PURL      string
	Version   string
	Ecosystem string
	DBPrefix  string
}

func digestParts(parts []string) string {
	hasher := sha256.New()
	for index, part := range parts {
		if index > 0 {
			_, _ = hasher.Write([]byte{0})
		}
		_, _ = hasher.Write([]byte(part))
	}
	return "sha256:" + hex.EncodeToString(hasher.Sum(nil))
}

func ecosystemDBPrefix(ecosystem string) (string, bool) {
	prefixes := map[string]string{
		"cargo":    "cargo::",
		"composer": "composer::",
		"gem":      "rubygems::",
		"golang":   "go::",
		"maven":    "maven::",
		"npm":      "npm::",
		"nuget":    "nuget::",
		"pypi":     "pip::",
	}
	prefix, ok := prefixes[ecosystem]
	return prefix, ok
}

func indexTrivyAdvisorySources(tx *bolt.Tx) (map[string][]*bolt.Bucket, error) {
	prefixes := []string{
		"cargo::",
		"composer::",
		"go::",
		"maven::",
		"npm::",
		"nuget::",
		"pip::",
		"rubygems::",
	}
	sources := make(map[string][]*bolt.Bucket, len(prefixes))
	err := tx.ForEach(func(name []byte, root *bolt.Bucket) error {
		value := string(name)
		for _, prefix := range prefixes {
			if strings.HasPrefix(value, prefix) {
				sources[prefix] = append(sources[prefix], root)
				break
			}
		}
		return nil
	})
	return sources, err
}

func parseScannedPURL(rawPURL, packageName, installedVersion string) (scannedTrivyPackage, bool) {
	if len(rawPURL) > maxAdvisoryText || len(packageName) > 500 ||
		len(installedVersion) > 500 || !strings.HasPrefix(rawPURL, "pkg:") ||
		strings.ContainsAny(rawPURL, " \t\r\n\\") {
		return scannedTrivyPackage{}, false
	}
	withoutSuffix := strings.SplitN(rawPURL, "#", 2)[0]
	withoutSuffix = strings.SplitN(withoutSuffix, "?", 2)[0]
	body := strings.TrimPrefix(withoutSuffix, "pkg:")
	slash := strings.IndexByte(body, '/')
	at := strings.LastIndexByte(body, '@')
	if slash <= 0 || at <= slash || at == len(body)-1 {
		return scannedTrivyPackage{}, false
	}
	ecosystem := strings.ToLower(body[:slash])
	version, err := url.PathUnescape(body[at+1:])
	if err != nil || version != installedVersion {
		return scannedTrivyPackage{}, false
	}
	prefix, supported := ecosystemDBPrefix(ecosystem)
	if !supported {
		return scannedTrivyPackage{
			Name: packageName, PURL: rawPURL, Version: installedVersion, Ecosystem: ecosystem,
		}, true
	}
	return scannedTrivyPackage{
		Name: packageName, PURL: rawPURL, Version: installedVersion,
		Ecosystem: ecosystem, DBPrefix: prefix,
	}, true
}

func parseScannedTrivyPackages(outputJSON string) ([]scannedTrivyPackage, error) {
	var envelope struct {
		SchemaVersion int               `json:"SchemaVersion"`
		Results       []json.RawMessage `json:"Results"`
	}
	if err := json.Unmarshal([]byte(outputJSON), &envelope); err != nil ||
		envelope.SchemaVersion != 2 {
		return nil, errors.New("trivy output format is invalid")
	}
	packages := make(map[string]scannedTrivyPackage)
	for _, rawResult := range envelope.Results {
		var result struct {
			Class           string          `json:"Class"`
			Type            string          `json:"Type"`
			Packages        json.RawMessage `json:"Packages"`
			Vulnerabilities json.RawMessage `json:"Vulnerabilities"`
		}
		if err := json.Unmarshal(rawResult, &result); err != nil {
			return nil, errors.New("trivy result format is invalid")
		}
		if len(result.Vulnerabilities) > 0 && string(result.Vulnerabilities) != "null" {
			var values []json.RawMessage
			if err := json.Unmarshal(result.Vulnerabilities, &values); err != nil {
				return nil, errors.New("trivy vulnerabilities format is invalid")
			}
		}
		if len(result.Packages) == 0 || string(result.Packages) == "null" {
			continue
		}
		var values []struct {
			Name       string `json:"Name"`
			Version    string `json:"Version"`
			Identifier struct {
				PURL string `json:"PURL"`
			} `json:"Identifier"`
		}
		if err := json.Unmarshal(result.Packages, &values); err != nil {
			return nil, errors.New("trivy packages format is invalid")
		}
		for _, value := range values {
			item, ok := parseScannedPURL(value.Identifier.PURL, value.Name, value.Version)
			if !ok {
				return nil, errors.New("trivy package identity is invalid")
			}
			if result.Class != "lang-pkgs" || strings.TrimSpace(result.Type) == "" {
				item.DBPrefix = ""
			}
			packages[item.PURL+"\x00"+item.Version] = item
		}
	}
	result := make([]scannedTrivyPackage, 0, len(packages))
	for _, item := range packages {
		result = append(result, item)
	}
	sort.Slice(result, func(i, j int) bool {
		return result[i].PURL+"\x00"+result[i].Version <
			result[j].PURL+"\x00"+result[j].Version
	})
	return result, nil
}

func validAdvisoryID(value string) bool {
	if len(value) < 3 || len(value) > 200 {
		return false
	}
	for index, character := range value {
		if (character >= 'A' && character <= 'Z') ||
			(character >= 'a' && character <= 'z') ||
			(character >= '0' && character <= '9') ||
			(index > 0 && strings.ContainsRune("._:+-", character)) {
			continue
		}
		return false
	}
	return true
}

func normalizeRanges(values []string) ([]string, bool) {
	if len(values) > maxAdvisoryRanges {
		return nil, false
	}
	seen := make(map[string]bool, len(values))
	result := make([]string, 0, len(values))
	for _, value := range values {
		value = strings.TrimSpace(value)
		if value == "" || len(value) > maxAdvisoryText ||
			strings.ContainsAny(value, "\x00\r\n") {
			return nil, false
		}
		if !seen[value] {
			seen[value] = true
			result = append(result, value)
		}
	}
	sort.Strings(result)
	return result, true
}

func mergeRanges(left, right []string) ([]string, bool) {
	return normalizeRanges(append(append([]string{}, left...), right...))
}

func recordFingerprint(databaseDigest string, record trivyAdvisoryRecord) string {
	return digestParts([]string{
		databaseDigest,
		record.Ecosystem,
		record.PackageName,
		record.PURL,
		record.InstalledVersion,
		record.AdvisoryID,
		strings.Join(record.VulnerableVersions, "\n"),
		strings.Join(record.PatchedVersions, "\n"),
		strings.Join(record.UnaffectedVersions, "\n"),
	})
}

func emptyTrivyAdvisoryQuery() trivyAdvisoryQueryResult {
	return trivyAdvisoryQueryResult{
		Completed: false, Records: []trivyAdvisoryRecord{}, RecordsSHA256: digestParts(nil),
	}
}

func queryTrivyAdvisories(
	dbPath string,
	outputJSON string,
	databaseDigest string,
	maximumRecords int,
) (trivyAdvisoryQueryResult, error) {
	empty := emptyTrivyAdvisoryQuery()
	if !validDigest(databaseDigest) || maximumRecords <= 0 || maximumRecords > 100_000 {
		return empty, errors.New("advisory query policy is invalid")
	}
	info, err := os.Lstat(dbPath)
	if err != nil || !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 {
		return empty, errors.New("vulnerability database is unavailable")
	}
	packages, err := parseScannedTrivyPackages(outputJSON)
	if err != nil {
		return empty, err
	}
	database, err := bolt.Open(dbPath, 0o400, &bolt.Options{
		ReadOnly: true,
		Timeout:  time.Second,
	})
	if err != nil {
		return empty, errors.New("vulnerability database cannot be opened read-only")
	}
	defer database.Close()

	complete := true
	merged := make(map[string]trivyAdvisoryRecord)
	err = database.View(func(tx *bolt.Tx) error {
		sources, err := indexTrivyAdvisorySources(tx)
		if err != nil {
			return err
		}
		for _, scannedPackage := range packages {
			if scannedPackage.DBPrefix == "" {
				complete = false
				continue
			}
			packageSources := sources[scannedPackage.DBPrefix]
			if len(packageSources) == 0 {
				complete = false
				continue
			}
			for _, root := range packageSources {
				component := root.Bucket([]byte(scannedPackage.Name))
				if component == nil {
					continue
				}
				if err := component.ForEach(func(advisoryID, raw []byte) error {
					if len(raw) == 0 || !validAdvisoryID(string(advisoryID)) {
						return errors.New("advisory record is invalid")
					}
					var advisory rawTrivyAdvisory
					if err := json.Unmarshal(raw, &advisory); err != nil {
						return errors.New("advisory record is invalid")
					}
					vulnerable, validVulnerable := normalizeRanges(advisory.VulnerableVersions)
					patched, validPatched := normalizeRanges(advisory.PatchedVersions)
					unaffected, validUnaffected := normalizeRanges(advisory.UnaffectedVersions)
					if !validVulnerable || !validPatched || !validUnaffected ||
						len(vulnerable)+len(patched)+len(unaffected) == 0 {
						return errors.New("advisory ranges are invalid")
					}
					key := scannedPackage.PURL + "\x00" + scannedPackage.Version +
						"\x00" + string(advisoryID)
					record, exists := merged[key]
					if !exists {
						record = trivyAdvisoryRecord{
							Ecosystem: scannedPackage.Ecosystem, PackageName: scannedPackage.Name,
							PURL: scannedPackage.PURL, InstalledVersion: scannedPackage.Version,
							AdvisoryID: string(advisoryID),
						}
					}
					mergedVulnerable, validVulnerableMerge := mergeRanges(
						record.VulnerableVersions,
						vulnerable,
					)
					mergedPatched, validPatchedMerge := mergeRanges(
						record.PatchedVersions,
						patched,
					)
					mergedUnaffected, validUnaffectedMerge := mergeRanges(
						record.UnaffectedVersions,
						unaffected,
					)
					if !validVulnerableMerge || !validPatchedMerge || !validUnaffectedMerge {
						return errors.New("advisory range budget exceeded")
					}
					record.VulnerableVersions = mergedVulnerable
					record.PatchedVersions = mergedPatched
					record.UnaffectedVersions = mergedUnaffected
					merged[key] = record
					if len(merged) > maximumRecords {
						return errors.New("advisory record limit exceeded")
					}
					return nil
				}); err != nil {
					return err
				}
			}
		}
		return nil
	})
	if err != nil {
		return empty, err
	}
	if !complete {
		return empty, nil
	}
	records := make([]trivyAdvisoryRecord, 0, len(merged))
	for _, record := range merged {
		record.RecordSHA256 = recordFingerprint(databaseDigest, record)
		records = append(records, record)
	}
	sort.Slice(records, func(i, j int) bool {
		left := records[i].PURL + "\x00" + records[i].InstalledVersion +
			"\x00" + records[i].AdvisoryID
		right := records[j].PURL + "\x00" + records[j].InstalledVersion +
			"\x00" + records[j].AdvisoryID
		return left < right
	})
	fingerprints := make([]string, 0, len(records))
	for _, record := range records {
		fingerprints = append(fingerprints, record.RecordSHA256)
	}
	return trivyAdvisoryQueryResult{
		Completed: true, Records: records, RecordsSHA256: digestParts(fingerprints),
	}, nil
}

func readVulnerabilityDBMetadata(path string) (trivyDBMetadata, time.Time, time.Time, error) {
	file, err := os.Open(filepath.Clean(path))
	if err != nil {
		return trivyDBMetadata{}, time.Time{}, time.Time{}, err
	}
	defer file.Close()
	decoder := newStrictDecoder(io.LimitReader(file, 4_097))
	var metadata trivyDBMetadata
	if err := decoder.Decode(&metadata); err != nil {
		return trivyDBMetadata{}, time.Time{}, time.Time{}, err
	}
	var extra any
	if err := decoder.Decode(&extra); !errors.Is(err, io.EOF) {
		return trivyDBMetadata{}, time.Time{}, time.Time{},
			errors.New("vulnerability database metadata has trailing data")
	}
	updatedAt, updatedErr := time.Parse(time.RFC3339Nano, metadata.UpdatedAt)
	nextUpdate, nextErr := time.Parse(time.RFC3339Nano, metadata.NextUpdate)
	if metadata.Version != 2 || updatedErr != nil || nextErr != nil ||
		!nextUpdate.After(updatedAt) {
		return trivyDBMetadata{}, time.Time{}, time.Time{},
			errors.New("vulnerability database metadata is invalid")
	}
	return metadata, updatedAt, nextUpdate, nil
}

func vulnerabilityDBStatus(metadataPath, configuredStatus string, now time.Time) (string, error) {
	_, _, nextUpdate, err := readVulnerabilityDBMetadata(metadataPath)
	if err != nil {
		return "", err
	}
	if configuredStatus != "CURRENT" && configuredStatus != "STALE" {
		return "", errors.New("vulnerability database status is invalid")
	}
	if configuredStatus == "STALE" || !now.Before(nextUpdate) {
		return "STALE", nil
	}
	return "CURRENT", nil
}
