package example_test

import (
	. "github.com/onsi/ginkgo/v2"
	. "github.com/onsi/gomega"
)

var _ = Describe("GinkgoAdd", func() {
	When("just making up a test", func() {
		It("it may still pass", func() {
			Expect(true).To(BeTrue())
		})
	})
	It("adds two numbers", func() {
		Expect(3 + 2).To(Equal(5))
	})
	It("puts on the lotion", func() {
		Expect(1 + 3).To(Equal(4))
	})
})

var _ = Describe("GinkgoStandardLibraryBehavior", func() {
	It("calculates string length", func() {
		Expect(len("Hello, Go")).To(Equal(9))
	})
})
