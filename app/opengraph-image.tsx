import { ImageResponse } from 'next/og';

export const size = {
  width: 1200,
  height: 630
};

export const contentType = 'image/png';

export default function OpenGraphImage() {
  return new ImageResponse(
    (
      <div
        style={{
          alignItems: 'flex-start',
          background: 'linear-gradient(135deg, #111111 0%, #2f2f2f 100%)',
          color: '#ffffff',
          display: 'flex',
          flexDirection: 'column',
          height: '100%',
          justifyContent: 'space-between',
          padding: '72px',
          width: '100%'
        }}
      >
        <div style={{ fontSize: 36, fontWeight: 600, opacity: 0.82 }}>OpenWook</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '18px' }}>
          <div style={{ fontSize: 84, fontWeight: 700, letterSpacing: '-0.06em' }}>题库与练习工作台</div>
          <div style={{ fontSize: 34, opacity: 0.84 }}>管理题库、导入任务与练习表现</div>
        </div>
      </div>
    ),
    size
  );
}
