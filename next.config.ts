import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  poweredByHeader: false,
  // Database clients open sockets and must stay as Node runtime dependencies, not bundled.
  serverExternalPackages: ["pg", "falkordb"],
};

export default nextConfig;
