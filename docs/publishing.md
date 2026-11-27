# Publishing and marketplace submissions

`package.json` owns the version. Push a matching `v<version>` source tag after updating the changelog and committing the release. The Release workflow checks, builds, and verifies the package before publishing its GitHub Release archive, immutable `dist-v<version>` tag, and newest stable `dist` branch.

## npm publication

Publish the exact GitHub Release `.tgz`, so npm and Git installations contain the same compiled entry points, localized guides, and Dockerfile. The first public publication uses an authenticated npm maintainer account:

```bash
npm login --registry=https://registry.npmjs.org/
npm publish ./dsh-cloud-sandbox-<version>.tgz --access public --registry=https://registry.npmjs.org/
```

The archive path above is the file downloaded from that version's GitHub Release. Confirm the version is publicly readable and its tarball downloads before submitting it to a market. Install it in a clean DSH profile, load the subprocess/shell/intake entry points, and run a command in the Docker sandbox.

For subsequent automatic stable releases, configure a GitHub Actions trusted publisher in the npm package settings:

- GitHub owner: `dengmuming`.
- Repository: `dsh-cloud-sandbox`.
- Workflow filename: `release.yml`.
- Environment: leave empty; the workflow declares no environment.
- Allow direct `npm publish`, since the workflow does not use staged publishing.

Then create the GitHub repository Actions variable `NPM_TRUSTED_PUBLISHING` with value `true`. Without it, GitHub releases still succeed and the npm job is skipped. With it, the workflow publishes only the newest stable release using OIDC, with no npm token stored in the repository. Configure the trusted publisher when ready to publish: npm requires its first successful publication within two days of configuration.

The npm job installs npm 11, downloads the verified Release archive, and checks any existing npm version against that archive's SHA-512 integrity. Identical versions are skipped; different bytes fail rather than replacing an immutable npm version. To retry the latest stable release, run the Release workflow manually with its existing source tag. Older releases and prereleases do not run this npm job.

## Community discovery

Keep the repository public, with a description, README homepage, and the `dsh-plugin` and `deepseek-harness` Topics. npm keywords include both names as well. Community directories have separate submission policies; publication alone does not guarantee listing.

For `awesome-dsh-plugin/awesome-dsh-plugin`, submit one YAML file named `data/plugins/dengmuming__dsh-cloud-sandbox.yml`, using the `security` category, an accurate English description, and optionally Chinese text. Supply a pinned GitHub Release `tarball` URL because the default branch contains source without compiled `dist/`. Update that URL when publishing a new version. If using `releases/latest/download/`, first attach an additional archive with a version-free filename; a versioned filename becomes stale when `latest` advances.

DSH accepts the package's SVG icon. The community list's optional `icon` field accepts only GitHub-hosted PNG/JPEG/WebP images; omit it to use the author's avatar unless a raster icon is provided.

## Custom DSH indexes

The official reference generator recognizes source version tags, not this repository's `dist-v*` convention. Prefer the npm package as its input. For a Git-only custom index, use the complete 40-character commit SHA of a precompiled `dist-v<version>` tag. Do not point installation entries at `main` or a source `v<version>` tag.

Discover's **Add index source** takes the HTTPS URL of `index.json`. The generator's `plugins.txt` takes npm names or repository URLs; these are different inputs.

## References

- [DSH plugin publication](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/develop/basic/publish.md)
- [DSH plugin indexes](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/guide/plugin-market.md)
- [npm trusted publishers](https://docs.npmjs.com/trusted-publishers/)
- [Awesome DSH Plugin contribution rules](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/blob/main/contributing.md)
