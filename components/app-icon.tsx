import { ImageResponse } from "next/og";

/** The DuoSync mark: two overlapping partner-coloured discs on brand indigo. */
export function renderAppIcon(size: number, opts: { maskable?: boolean; rounded?: boolean } = {}) {
  // Maskable icons keep the mark inside the central 80% safe zone.
  const inner = opts.maskable ? size * 0.5 : size * 0.62;
  const disc = inner * 0.66;
  const radius = opts.rounded === false || opts.maskable ? 0 : size * 0.22;
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "#5b4bdb",
          borderRadius: radius,
        }}
      >
        <div style={{ display: "flex", position: "relative", width: inner, height: disc }}>
          <div
            style={{
              position: "absolute",
              left: 0,
              top: 0,
              width: disc,
              height: disc,
              borderRadius: disc,
              background: "#ff7a66",
            }}
          />
          <div
            style={{
              position: "absolute",
              right: 0,
              top: 0,
              width: disc,
              height: disc,
              borderRadius: disc,
              background: "#2dd4bf",
              opacity: 0.92,
            }}
          />
        </div>
      </div>
    ),
    { width: size, height: size },
  );
}
