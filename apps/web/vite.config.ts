import { defineConfig, Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const apiProxyTarget = process.env["VITE_API_PROXY_TARGET"] || "http://localhost:3000";
const siteUrl = (process.env["SITE_URL"] || process.env["VITE_SITE_URL"] || "")
  .trim()
  .replace(/\/$/, "");

function siteUrlPlugin(): Plugin {
  return {
    name: "site-url-html-transform",
    transformIndexHtml(html: string) {
      let transformed = html;

      if (siteUrl) {
        const ogImageTags = `    <meta property="og:image" content="${siteUrl}/images/hero-terrain.webp" />\n    <meta name="twitter:image" content="${siteUrl}/images/hero-terrain.webp" />`;
        transformed = transformed.replace("<!-- OG_IMAGE_TAGS -->", ogImageTags);

        const canonicalTags = `    <link rel="canonical" href="${siteUrl}/" />\n    <meta property="og:url" content="${siteUrl}/" />\n    <meta name="twitter:url" content="${siteUrl}/" />`;
        transformed = transformed.replace("<!-- CANONICAL_AND_OG_URL -->", canonicalTags);
      } else {
        // When SITE_URL is unset, omit canonical, og:url, og:image, and twitter:image entirely
        transformed = transformed.replace("<!-- OG_IMAGE_TAGS -->", "");
        transformed = transformed.replace("<!-- CANONICAL_AND_OG_URL -->", "");
      }
      return transformed;
    },
  };
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss(), siteUrlPlugin()],
  server: {
    port: parseInt(process.env["VITE_PORT"] || "5173", 10),
    proxy: {
      "/api": {
        target: apiProxyTarget,
        changeOrigin: true,
      },
      "/healthz": {
        target: apiProxyTarget,
        changeOrigin: true,
      },
      "/socket.io": {
        target: apiProxyTarget,
        changeOrigin: true,
        ws: true,
      },
      "/sync": {
        target: apiProxyTarget,
        changeOrigin: true,
        ws: true,
      },
    },
  },
});
