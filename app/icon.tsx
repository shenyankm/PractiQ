import { ImageResponse } from 'next/og';

export const size = {
  width: 32,
  height: 32
};

export const contentType = 'image/png';

export default function Icon() {
  return new ImageResponse(
    (
      <div
        style={{
          alignItems: 'center',
          background: '#111111',
          color: '#ffffff',
          display: 'flex',
          fontSize: 16,
          fontWeight: 700,
          height: '100%',
          justifyContent: 'center',
          letterSpacing: '-0.08em',
          width: '100%'
        }}
      >
        OW
      </div>
    ),
    size
  );
}
