# Maintainer publishing checklist

There are three different operations:

1. **Publish a diagram into a session:** use snapshot/publish tools; see
   [the authoring procedure](setup.md#publish-a-diagram).
2. **Push project changes to Git:** distribute source and documentation through
   the existing remote. This does not publish an npm package.
3. **Publish the plugin package:** an explicit registry release after the
   prerequisites below. This does not automatically change repository visibility.

## 1. Verify the checkout

Run maintainer commands from a repository checkout, not from an installed package:

```sh
npm ci
npm run verify
npm run docs:images
npm run docs:check
npm pack --dry-run
git diff --check
git status --short
```

Review the image changes visually. Confirm the architecture/source map remains
accurate and that no credentials, private session content, local configuration,
or temporary artifacts entered the diff. Tests use isolated fixture services;
they must not call paid models or modify the shared OpenCode service.

Native runtime checks need `opencode` and `python3`. Use Node 26.4+ for the native
OpenTUI test rather than treating an older-Node skip as proof of rendering.
Record the exact `opencode --version` used. Host compatibility is OpenCode 2.x
(`>=2.0.7 <3`); dependency pins do not require the user to downgrade the host.
Do not describe an untested future minor release as already verified.

## 2. Commit and push to Git

1. Inspect `git diff` and the untracked files shown by `git status`.
2. Stage only intended source, tests, docs, and generated images. Review
   `git diff --cached` before committing.
3. Commit with a message describing the shipped change.
4. Confirm `git remote -v` points to the intended repository and that the remote
   branch has not advanced unexpectedly.
5. Push normally, for example `git push origin main` from this repository's main
   branch. Do not force-push over others' work.
6. Confirm the remote branch points to the new commit and the checkout is clean.

## 3. Prepare an npm release — not enabled yet

The package currently has **`private: true`** and the repository has **no selected
license**. This checklist is not a claim that a public npm package exists or an
authorization to choose licensing terms on the owner's behalf.

Before a registry release, the maintainer must:

1. Choose a license and add its text plus matching `package.json` metadata.
2. Choose and verify ownership of the npm package name/scope. Do not assume the
   unscoped name `open-diagram` is available or belongs to this repository.
3. Check repository URL, homepage, bugs URL, version and supported host range.
4. Remove `private: true` only when publication is intentional. Keep package and
   lockfile root metadata synchronized if the name or version changes.
5. Choose the release version. Use the normal npm version workflow and review the
   resulting manifest/lockfile changes and any generated commit/tag.
6. Repeat verification and inspect `npm pack --dry-run`. The package must contain
   `server.ts`, `tui.tsx`, `src`, and its linked documentation/images. Do not remove
   the `./harness` and `./rpc` exports or the native TUI entrypoint.
7. Run `npm pack` and smoke-test that tarball in a disposable project with the
   supported OpenCode runtime. Inspect both manual authoring and the native TUI.
   Keep credentials and real provider billing out of automated release checks.

## 4. Publish the package explicitly

Only after those decisions and checks:

```sh
npm login
npm whoami
npm publish --dry-run
npm publish --access public
```

Confirm the target registry and account before the final command. Follow npm's
current authentication/2FA or trusted-publishing requirements. A dry run does not
publish. Do not put npm tokens in this repository or plugin configuration.

Then push the intended release commit/tag, verify registry metadata and package
contents, and update installation instructions to the actual published name and
version. A consumer can then replace the local checkout path with that package:

```json
{
  "plugins": [{
    "package": "@YOUR_SCOPE/YOUR_PACKAGE@YOUR_VERSION",
    "options": {
      "backend": "opencode",
      "providerID": "YOUR_PROVIDER_ID",
      "model": "YOUR_MODEL_ID"
    }
  }]
}
```

Those are placeholders, not a currently published installation command. Model
selection still belongs in **plugin options**; it does not change the consumer's
chat/agent routing. Link users to [setup](setup.md) for authentication, variants,
endpoint alternatives and manual diagram publication.
