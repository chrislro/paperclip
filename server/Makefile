PYTHON   ?= python3.12
VENV     := venv
PIP      := $(VENV)/bin/pip
PYTEST   := $(VENV)/bin/pytest
MARK     ?= invariant

.PHONY: test-extension test-invariant test-replay test-loader test-live test-backend venv-extension clean-extension

## Run extension E2E / invariant tests
## Usage: make test-extension MARK="invariant"
test-extension: $(VENV)/bin/pytest
	$(PYTEST) tests/extension/ -m "$(MARK)" -v --tb=short --ignore=tests/extension/backend

## Run specific test suites
test-invariant: $(VENV)/bin/pytest
	$(PYTEST) tests/extension/ -m "invariant" -v --tb=short

test-replay: $(VENV)/bin/pytest
	$(PYTEST) tests/extension/ -m "replay" -v --tb=short

test-loader: $(VENV)/bin/pytest
	$(PYTEST) tests/extension/ -m "loader" -v --tb=short

test-live: $(VENV)/bin/pytest
	@echo "WARNING: Running live EMR tests — requires G-Hosp credentials and network access"
	$(PYTEST) tests/extension/ -m "live_emr" -v --tb=short

test-backend: $(VENV)/bin/pytest
	$(PYTEST) backend/tests/ -v --tb=short

## Set up the test virtual environment
$(VENV)/bin/pytest: requirements-test.txt
	$(PYTHON) -m venv $(VENV)
	$(PIP) install --upgrade pip --quiet
	$(PIP) install -r requirements-test.txt --quiet

venv-extension: $(VENV)/bin/pytest

clean-extension:
	rm -rf $(VENV) test-artifacts/ .pytest_cache/
