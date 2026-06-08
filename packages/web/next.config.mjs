/** @type {import('next').NextConfig} */
const nextConfig = {
  // @pulse/shared ships raw TypeScript source (no build step), so Next must
  // transpile it like first-party app code.
  transpilePackages: ['@pulse/shared'],
};

export default nextConfig;
