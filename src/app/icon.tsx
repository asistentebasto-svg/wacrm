import { ImageResponse } from "next/og";

// Replaces the default Next.js favicon with the BASTO brand mark — a
// deep-navy (#1a2332) rounded square with a teal (#4ECDC4) "B",
// matching the sidebar logo in `src/components/layout/sidebar.tsx`.
// Next.js renders this at build time and auto-injects <link rel="icon">
// into <head>.
//
// This route takes precedence over src/app/favicon.ico, which is the
// Next.js default and can stay on disk harmlessly (or be removed).

export const runtime = "edge";
export const size = { width: 32, height: 32 };
export const contentType = "image/png";

export default function Icon() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "#1a2332", // BASTO deep navy
          borderRadius: 6,
        }}
      >
        <div
          style={{
            display: "flex",
            fontSize: 22,
            fontWeight: 700,
            color: "#4ECDC4", // BASTO teal
            lineHeight: 1,
          }}
        >
          B
        </div>
      </div>
    ),
    { ...size },
  );
}
