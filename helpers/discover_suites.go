package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"go/ast"
	"go/parser"
	"go/token"
	"io/fs"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

// SuiteEntry represents a discovered suite bootstrap in a file.
type SuiteEntry struct {
	// the file in which the suite bootstrap was found
	File string `json:"file"`
	// the name of the suite as given to RunSpecs
	Suite string `json:"suite"`
	// the name of the Test* function that bootstraps the suite
	Bootstrap string `json:"bootstrap"`
}

// This utility scans *_test.go files under -dir and finds Test* functions
// that call RunSpecs. It emits a JSON array of SuiteEntry objects.

func main() {
	dir := flag.String("dir", ".", "directory to scan")
	flag.Parse()

	results := []SuiteEntry{}

	fset := token.NewFileSet()

	walkErr := filepath.WalkDir(*dir, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() {
			return nil
		}
		if !strings.HasSuffix(d.Name(), "_test.go") {
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

		// Inspect file for FuncDecl with name starting with Test
		for _, decl := range file.Decls {
			fn, ok := decl.(*ast.FuncDecl)
			if !ok || fn.Name == nil {
				continue
			}
			name := fn.Name.Name
			if !strings.HasPrefix(name, "Test") {
				continue
			}

			// inspect the function body for calls to RunSpecs
			found := false
			ast.Inspect(fn, func(n ast.Node) bool {
				if found {
					return false
				}
				call, ok := n.(*ast.CallExpr)
				if !ok {
					return true
				}
				// function may be ident or selector
				switch fun := call.Fun.(type) {
				case *ast.Ident:
					if fun.Name == "RunSpecs" {
						suiteName := name
						if len(call.Args) >= 2 {
							if lit, ok := call.Args[1].(*ast.BasicLit); ok && lit.Kind == token.STRING {
								if unq, err := strconv.Unquote(lit.Value); err == nil {
									suiteName = unq
								}
							}
						}
						results = append(results, SuiteEntry{File: filepath.Base(path), Suite: suiteName, Bootstrap: name})
						found = true
						return false
					}
				case *ast.SelectorExpr:
					if fun.Sel != nil && fun.Sel.Name == "RunSpecs" {
						suiteName := name
						if len(call.Args) >= 2 {
							if lit, ok := call.Args[1].(*ast.BasicLit); ok && lit.Kind == token.STRING {
								if unq, err := strconv.Unquote(lit.Value); err == nil {
									suiteName = unq
								}
							}
						}
						results = append(results, SuiteEntry{File: filepath.Base(path), Suite: suiteName, Bootstrap: name})
						found = true
						return false
					}
				}
				return true
			})
		}

		return nil
	})

	if walkErr != nil {
		fmt.Fprintln(os.Stderr, "error walking dir:", walkErr)
		os.Exit(2)
	}

	enc := json.NewEncoder(os.Stdout)
	enc.SetIndent("", "  ")
	_ = enc.Encode(results)
}
