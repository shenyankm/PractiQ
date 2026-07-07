import { ImageResponse } from 'next/og';

export const size = {
  width: 180,
  height: 180
};

export const contentType = 'image/png';

export default function AppleIcon() {
  return new ImageResponse(
    (
      <div
        style={{
          alignItems: 'center',
          background: '#111111',
          borderRadius: 36,
          color: '#ffffff',
          display: 'flex',
          fontSize: 84,
          fontWeight: 700,
          height: '100%',
          justifyContent: 'center',
          letterSpacing: '-0.12em',
          width: '100%'
        }}
      >
        OW
      </div>
    ),
    size
  );
}
