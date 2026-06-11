/** @type {import('next').NextConfig} */
const nextConfig = {
  // @pulse/shared ships raw TypeScript source (no build step), so Next must
  // transpile it like first-party app code.
  transpilePackages: ['@pulse/shared'],
  webpack: (config) => {
    // shared uses moduleResolution node16, so its internal imports say
    // "./scoring.js" while the file on disk is scoring.ts. tsc maps that
    // automatically; webpack only does with this alias. Unnoticed until 4c
    // because every earlier web import of @pulse/shared was type-only (erased
    // at compile time) — DEFAULT_SCHEDULE is the first value import.
    config.resolve.extensionAlias = {
      '.js': ['.ts', '.tsx', '.js'],
      ...config.resolve.extensionAlias,
    };
    return config;
  },
};

export default nextConfig;
