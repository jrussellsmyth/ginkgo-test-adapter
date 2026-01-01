package example_test

import (
	. "github.com/onsi/ginkgo/v2"
	. "github.com/onsi/gomega"

	example "ginkgo-example"
)

var _ = Describe("GinkgoAdd", func() {
	It("adds two numbers", func() {
		Expect(example.Add(2, 3)).To(Equal(5))
	})
	It("puts on the lotion", func() {
		Expect(example.Add(1, 3)).To(Equal(4))
	})
})

var _ = Describe("GinkgoStandardLibraryBehavior", func() {
	It("calculates string length", func() {
		Expect(len("Hello, Go")).To(Equal(9))
	})
})
