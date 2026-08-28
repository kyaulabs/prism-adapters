# Encrypted signing-key support specification

**Date:** 2026-08-28
**Status:** Approved
**Applies to:** Prism adapter catalogue publisher

## Purpose

Allow the human-only catalogue signing command to use the production encrypted
PKCS#8 Ed25519 key without weakening private-key custody. Make the interactive
path prompt accept familiar home-directory prefixes without evaluating shell
syntax.

## Requirements

### Signing-key paths

The private-key path resolver must:

- accept absolute paths and repository-relative paths;
- expand only a leading `~/`, `$HOME/`, or `${HOME}/` prefix using the operating
  system home directory;
- reject directories, symlinks, empty files, oversized files, and paths that
  resolve inside the repository;
- perform no shell execution, command substitution, glob expansion, or general
  environment-variable expansion; and
- avoid printing the supplied path.

### Encrypted PKCS#8 keys

The interactive signing command must:

- continue rejecting non-interactive input before requesting private-key data;
- accept unencrypted PKCS#8 Ed25519 keys as before;
- recognize encrypted PKCS#8 PEM input and request its passphrase in a second
  TTY-only prompt;
- suppress passphrase echo and restore terminal mode on success, failure, and
  interruption;
- hold the passphrase in a buffer only for key parsing and zero that buffer in
  `finally`;
- never place the passphrase in command arguments, environment variables,
  files, logs, fixtures, errors, or output;
- reject empty or incorrect passphrases, unsupported key formats, non-Ed25519
  keys, and keys that do not match the trusted public key; and
- preserve atomic `catalogue.json` publication.

## Error handling

Failures remain generic and fail closed. A path-validation failure reports that
the key is unavailable or inside the repository. A parse, decryption, or format
failure reports that the private signing key is invalid. Cancellation writes no
catalogue and returns a non-zero status.

## Test seams

Tests use ephemeral Ed25519 key pairs and synthetic passphrases only. Through
the public CLI seam they cover:

- `~/`, `$HOME/`, and `${HOME}/` path expansion;
- rejection of arbitrary variable expansion;
- successful envelope creation from encrypted PKCS#8 input;
- rejection of an incorrect passphrase;
- non-interactive rejection before either sensitive prompt; and
- continued key-pair matching and outside-repository enforcement.

No test reads or references the production private key.

## Documentation

`README.md` and `SECURITY.md` describe the encrypted-key flow, hidden passphrase
prompt, accepted home-directory spellings, and prohibition on putting paths or
passphrases in arguments, environment variables, files, logs, or chat.

## Non-goals

- General shell-style path expansion
- Passphrase arguments, environment variables, files, agents, or keychains
- Support for OpenSSH or raw Ed25519 private-key formats
- Changes to catalogue payload bytes, sequence handling, trust identity, or
  public-key fingerprint

<!-- vim: ft=markdown sts=4 sw=4 ts=4 et : -->
