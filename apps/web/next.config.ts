import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  cacheComponents: true,
  output: "standalone",
  transpilePackages: ["@wpm/shared"],
  outputFileTracingIncludes: {
    "/**/*": ["./src/lib/db/migrations/**/*"],
  },
};

export default nextConfig;
