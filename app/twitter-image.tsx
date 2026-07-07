import { ImageResponse } from 'next/og';

export const size = {
  width: 1200,
  height: 600
};

export const contentType = 'image/png';

export default function TwitterImage() {
  return new ImageResponse(
    (
      <div
        style={{
          alignItems: 'flex-start',
          background: '#111111',
          color: '#ffffff',
          display: 'flex',
          flexDirection: 'column',
          gap: '28px',
          height: '100%',
          justifyContent: 'center',
          padding: '64px',
          width: '100%'
        }}
      >
        <div style={{ fontSize: 32, fontWeight: 600, opacity: 0.82 }}>OpenWook</div>
        <div style={{ fontSize: 72, fontWeight: 700, letterSpacing: '-0.06em' }}>题库与练习工作台</div>
        <div style={{ fontSize: 30, opacity: 0.82 }}>导入、管理、练习，一条链路完成。</div>
      </div>
    ),
    size
  );
}
