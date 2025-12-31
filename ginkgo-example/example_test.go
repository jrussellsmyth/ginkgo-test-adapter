package example

import (
    "testing"

    . "github.com/onsi/gomega"
)

func TestAdd(t *testing.T) {
    g := NewWithT(t)
    g.Expect(Add(2, 3)).To(Equal(5))
}

func TestStandardLibraryBehavior(t *testing.T) {
    g := NewWithT(t)
    // use the standard library to check behavior of strings
    s := "Hello, Go"
    g.Expect(len(s)).To(Equal(9))
}
