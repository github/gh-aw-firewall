# Agentic Workflow Firewall Documentation

This directory contains the Astro Starlight documentation site for the Agentic Workflow Firewall.

## Development

### Prerequisites

- Node.js 18+
- npm

### Setup

```bash
# Install dependencies
npm install

# Start development server
npm run dev
```

The site will be available at `http://localhost:4321`

### Build

```bash
# Build for production
npm run build

# Preview production build
npm run preview
```

## Mermaid and KaTeX compatibility

`astro-mermaid@2.1.0` supports Mermaid 10 and 11, while Mermaid `11.17.2` declares
`katex: ^0.16.47`. The docs site intentionally overrides KaTeX to `0.18.2` to
use the patched release while retaining the supported Mermaid integration. This
is an accepted compatibility exception because `0.18.2` is outside Mermaid's
declared range; keep it with rendering validation and revisit when the Mermaid
integration supports a compatible release.

Validation on Node 22.23.3 passed `npm ci` and `npm run build`. A Chromium check
rendered flowchart math labels (`$$x^2$$`, `$$\sqrt{x}$$`, and
`$$\frac{1}{2}$$`) in both light and dark themes, with three KaTeX MathML
outputs and no Mermaid errors. The sandbox could not resolve the lockfile's
Azure npm mirror URLs, so installation used equivalent public-registry URLs
without changing package versions or lockfile resolutions.

## Structure

```
docs-site/
├── src/
│   ├── assets/          # Images and static assets
│   ├── content/
│   │   └── docs/        # Documentation content (Markdown/MDX)
│   └── styles/          # Custom CSS
├── public/              # Public static files
├── astro.config.mjs     # Astro configuration
└── package.json
```

## Deployment

The documentation is automatically deployed to GitHub Pages when changes are pushed to the `main` branch.

Workflow: `.github/workflows/deploy-docs.yml`

## Links

- [Astro Documentation](https://docs.astro.build/)
- [Starlight Documentation](https://starlight.astro.build/)
- [Live Site](https://github.github.io/gh-aw-firewall/)
