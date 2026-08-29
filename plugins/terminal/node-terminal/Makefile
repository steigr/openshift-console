# Local Linux dev/test convenience. Only makes sense on Linux (glibc, and
# most steps in the binary itself require Linux syscalls) -- the static,
# multi-arch release binary/image is built via Docker (see ./Dockerfile and
# the root Makefile's build-terminal-shim/push-terminal-shim targets), not
# this file.

CC      ?= gcc
CFLAGS  ?= -Wall -Wextra -O2 -std=gnu11
INCLUDE := -Iinclude

SRC_DIR := src
BIN_DIR := bin
OBJ_DIR := $(BIN_DIR)/obj

LIB_SRCS := $(filter-out $(SRC_DIR)/main.c,$(wildcard $(SRC_DIR)/*.c))
LIB_OBJS := $(patsubst $(SRC_DIR)/%.c,$(OBJ_DIR)/%.o,$(LIB_SRCS))
MAIN_OBJ := $(OBJ_DIR)/main.o

TEST_SRCS := $(wildcard tests/unit/test_*.c)
TEST_BINS := $(patsubst tests/unit/test_%.c,$(BIN_DIR)/test_%,$(TEST_SRCS))

.PHONY: all static test clean

all: $(BIN_DIR)/node-terminal-shim

static: CFLAGS += -static
static: $(BIN_DIR)/node-terminal-shim

$(OBJ_DIR)/%.o: $(SRC_DIR)/%.c include/*.h
	@mkdir -p $(OBJ_DIR)
	$(CC) $(CFLAGS) $(INCLUDE) -c $< -o $@

$(BIN_DIR)/node-terminal-shim: $(LIB_OBJS) $(MAIN_OBJ)
	@mkdir -p $(BIN_DIR)
	$(CC) $(CFLAGS) $^ -o $@

# Each tests/unit/test_X.c is compiled directly against the library sources
# it needs (no main.c) -- run via `make test`, or an individual binary via
# `make bin/test_X && ./bin/test_X`.
$(BIN_DIR)/test_%: tests/unit/test_%.c $(LIB_SRCS) include/*.h
	@mkdir -p $(BIN_DIR)
	$(CC) $(CFLAGS) $(INCLUDE) -Itests/unit $< $(LIB_SRCS) -o $@

test: $(TEST_BINS)
	@set -e; for t in $(TEST_BINS); do echo "== $$t =="; $$t; done

clean:
	rm -rf $(BIN_DIR)
