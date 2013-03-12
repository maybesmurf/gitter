TESTS = test/integration
REPORTER = dot

test:
	@NODE_ENV=test ./node_modules/.bin/mocha \
		--reporter $(REPORTER) \
		--timeout 2000 \
		--recursive \
		--ignore-leaks \
		$(TESTS)

docs: test-docs

test-docs:
	make test REPORTER=doc \
		| cat docs/head.html - docs/tail.html \
		> docs/test.html

.PHONY: test-cov test docs test-docs clean
