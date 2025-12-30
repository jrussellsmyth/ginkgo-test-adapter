package main

import (
	"bytes"
	"fmt"
	"go/ast"
	"go/parser"
	"go/token"
	"io/fs"
	"math/rand"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func discoverParseOnly(dir string) (map[string]string, error) {
	results := map[string]string{}
	fset := token.NewFileSet()

	err := filepath.WalkDir(dir, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() || !strings.HasSuffix(d.Name(), "_test.go") {
			return nil
		}
		src, err := os.ReadFile(path)
		if err != nil {
			return nil
		}
		file, err := parser.ParseFile(fset, path, src, parser.ParseComments)
		if err != nil {
			return nil
		}
		for _, decl := range file.Decls {
			fn, ok := decl.(*ast.FuncDecl)
			if !ok || fn.Name == nil {
				continue
			}
			name := fn.Name.Name
			if !strings.HasPrefix(name, "Test") {
				continue
			}
			found := false
			ast.Inspect(fn, func(n ast.Node) bool {
				if found {
					return false
				}
				call, ok := n.(*ast.CallExpr)
				if !ok {
					return true
				}
				switch fun := call.Fun.(type) {
				case *ast.Ident:
					if fun.Name == "RunSpecs" {
						results[filepath.Base(path)] = name
						found = true
						return false
					}
				case *ast.SelectorExpr:
					if fun.Sel != nil && fun.Sel.Name == "RunSpecs" {
						results[filepath.Base(path)] = name
						found = true
						return false
					}
				}
				return true
			})
		}
		return nil
	})
	return results, err
}

func discoverWithPreFilter(dir string) (map[string]string, error) {
	results := map[string]string{}
	fset := token.NewFileSet()

	err := filepath.WalkDir(dir, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() || !strings.HasSuffix(d.Name(), "_test.go") {
			return nil
		}
		src, err := os.ReadFile(path)
		if err != nil {
			return nil
		}
		// fast pre-filter
		if !bytes.Contains(src, []byte("RunSpecs")) {
			return nil
		}
		file, err := parser.ParseFile(fset, path, src, parser.ParseComments)
		if err != nil {
			return nil
		}
		for _, decl := range file.Decls {
			fn, ok := decl.(*ast.FuncDecl)
			if !ok || fn.Name == nil {
				continue
			}
			name := fn.Name.Name
			if !strings.HasPrefix(name, "Test") {
				continue
			}
			found := false
			ast.Inspect(fn, func(n ast.Node) bool {
				if found {
					return false
				}
				call, ok := n.(*ast.CallExpr)
				if !ok {
					return true
				}
				switch fun := call.Fun.(type) {
				case *ast.Ident:
					if fun.Name == "RunSpecs" {
						results[filepath.Base(path)] = name
						found = true
						return false
					}
				case *ast.SelectorExpr:
					if fun.Sel != nil && fun.Sel.Name == "RunSpecs" {
						results[filepath.Base(path)] = name
						found = true
						return false
					}
				}
				return true
			})
		}
		return nil
	})
	return results, err
}

// makeCorpus creates `total` *_test.go files inside dir.
// pctRunSpecs percent of files will contain a Test function that calls RunSpecs.
// avgLines adds filler comments to increase file size.
func makeCorpus(dir string, total int, pctRunSpecs int, avgLines int) error {
	if total <= 0 {
		return nil
	}
	rand.Seed(42) // deterministic between runs
	numWith := total * pctRunSpecs / 100

	for i := 0; i < total; i++ {
		name := fmt.Sprintf("zz_auto_%05d_test.go", i)
		path := filepath.Join(dir, name)
		f, err := os.Create(path)
		if err != nil {
			return err
		}
		fmt.Fprintln(f, "package gen_test")
		fmt.Fprintln(f, "import (")
		fmt.Fprintln(f, `  "testing"`)
		fmt.Fprintln(f, ")")

		if i < numWith {
			// include a bootstrap-like Test that calls RunSpecs
			fmt.Fprintln(f, "")
			fmt.Fprintln(f, "func TestAuto_run(t *testing.T) {")
			fmt.Fprintln(f, `  RunSpecs(t, "Auto Suite")`)
			fmt.Fprintln(f, "}")
		} else {
			// regular test or noop
			fmt.Fprintln(f, "")
			fmt.Fprintln(f, "func TestAuto_noop(t *testing.T) {")
			fmt.Fprintln(f, "  // noop")
			fmt.Fprintln(f, "}")
		}

		// filler lines
		for l := 0; l < avgLines; l++ {
			fmt.Fprintln(f, "// filler line")
		}
		f.Close()
	}
	return nil
}

func BenchmarkDiscover_ParseOnly(b *testing.B) {
	// create a larger corpus to amplify differences
	total := 1000
	pctRunSpecs := 5
	avgLines := 50

	b.ReportAllocs()
	for i := 0; i < b.N; i++ {
		tmp, err := os.MkdirTemp("", "discover_bench_parseonly")
		if err != nil {
			b.Fatalf("tmpdir: %v", err)
		}
		// stop timer while generating corpus
		b.StopTimer()
		if err := makeCorpus(tmp, total, pctRunSpecs, avgLines); err != nil {
			b.Fatalf("makeCorpus: %v", err)
		}
		b.StartTimer()

		_, err = discoverParseOnly(tmp)
		if err != nil {
			b.Fatalf("discoverParseOnly error: %v", err)
		}

		b.StopTimer()
		os.RemoveAll(tmp)
		b.StartTimer()
	}
}

func BenchmarkDiscover_WithPreFilter(b *testing.B) {
	total := 1000
	pctRunSpecs := 5
	avgLines := 50

	b.ReportAllocs()
	for i := 0; i < b.N; i++ {
		tmp, err := os.MkdirTemp("", "discover_bench_prefilter")
		if err != nil {
			b.Fatalf("tmpdir: %v", err)
		}
		b.StopTimer()
		if err := makeCorpus(tmp, total, pctRunSpecs, avgLines); err != nil {
			b.Fatalf("makeCorpus: %v", err)
		}
		b.StartTimer()

		_, err = discoverWithPreFilter(tmp)
		if err != nil {
			b.Fatalf("discoverWithPreFilter error: %v", err)
		}

		b.StopTimer()
		os.RemoveAll(tmp)
		b.StartTimer()
	}
}
