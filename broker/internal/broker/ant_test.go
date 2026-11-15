package broker

import (
	"archive/tar"
	"archive/zip"
	"bytes"
	"compress/gzip"
	"context"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
)

func TestAntAssetIsPinned(t *testing.T) {
	asset, err := antAsset()
	if err != nil {
		t.Skipf("no ant release for this platform: %v", err)
	}
	if antChecksums[asset] == "" || !strings.Contains(asset, antVersion) {
		t.Fatalf("asset %s has no pinned checksum", asset)
	}
}

func TestAntInstallRejectsChecksumMismatch(t *testing.T) {
	asset, err := antAsset()
	if err != nil {
		t.Skip(err)
	}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasSuffix(r.URL.Path, asset) {
			_, _ = w.Write([]byte("tampered archive"))
			return
		}
		http.NotFound(w, r)
	}))
	defer server.Close()
	tool := newAntTool(t.TempDir())
	tool.downloadURL = server.URL + "/"
	t.Setenv("CREDNE_ANT", "")
	if _, err = tool.executable(context.Background()); err == nil || !strings.Contains(err.Error(), "checksum mismatch") {
		t.Fatalf("tampered download accepted: %v", err)
	}
	if _, statErr := filepath.Glob(filepath.Join(tool.home, "bin", "*")); statErr != nil {
		t.Fatal(statErr)
	}
}

func TestExtractAnt(t *testing.T) {
	want := antBinaryName()
	var zipped bytes.Buffer
	zw := zip.NewWriter(&zipped)
	w, _ := zw.Create("ant_dir/" + want)
	_, _ = w.Write([]byte("zip-binary"))
	_ = zw.Close()
	if got, err := extractAnt("ant.zip", zipped.Bytes()); err != nil || string(got) != "zip-binary" {
		t.Fatalf("zip: %q %v", got, err)
	}

	var tarred bytes.Buffer
	gz := gzip.NewWriter(&tarred)
	tw := tar.NewWriter(gz)
	_ = tw.WriteHeader(&tar.Header{Name: "README.md", Mode: 0o644, Size: 2, Typeflag: tar.TypeReg})
	_, _ = tw.Write([]byte("hi"))
	_ = tw.WriteHeader(&tar.Header{Name: want, Mode: 0o755, Size: 10, Typeflag: tar.TypeReg})
	_, _ = tw.Write([]byte("tar-binary"))
	_ = tw.Close()
	_ = gz.Close()
	if got, err := extractAnt("ant.tar.gz", tarred.Bytes()); err != nil || string(got) != "tar-binary" {
		t.Fatalf("tar.gz: %q %v", got, err)
	}
}

func TestCreditsExhaustedIsAccountScoped(t *testing.T) {
	err := newUpstreamError(http.StatusBadRequest, http.Header{}, []byte(`{"type":"error","error":{"type":"invalid_request_error","message":"Your credit balance is too low to access the Anthropic API."}}`))
	if err.StatusCode() != http.StatusPaymentRequired || err.RetryAfter() == nil || *err.RetryAfter() != creditsExhaustedRetry {
		t.Fatalf("credit exhaustion not mapped to a resting account: %+v", err)
	}
	limited := newUpstreamError(http.StatusTooManyRequests, http.Header{"Retry-After": {"12"}}, []byte("slow down"))
	if limited.RetryAfter() == nil || limited.RetryAfter().Seconds() != 12 {
		t.Fatalf("Retry-After not parsed: %+v", limited)
	}
}
