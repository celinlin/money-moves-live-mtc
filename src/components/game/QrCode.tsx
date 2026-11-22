import { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import { cn } from '@/lib/utils';

export function QrCode({ value, className, label }: { value: string; className?: string; label?: string }) {
  const [svg, setSvg] = useState('');
  useEffect(() => {
    let alive = true;
    QRCode.toString(value, {
      type: 'svg',
      margin: 0,
      errorCorrectionLevel: 'M',
      color: { dark: '#1c0711', light: '#00000000' },
    }).then((s) => alive && setSvg(s));
    return () => {
      alive = false;
    };
  }, [value]);
  return (
    <div className={cn('flex flex-col items-center', className)}>
      <div
        className="aspect-square w-full rounded-[9%] bg-[oklch(91%_0.06_110)] p-[7%] shadow-[0_30px_80px_-30px_oklch(72%_0.11_80_/_0.35)] [&_svg]:h-full [&_svg]:w-full"
        role="img"
        aria-label={`QR code : ${value}`}
        dangerouslySetInnerHTML={{ __html: svg }}
      />
      {label && <p className="mt-[6%] text-center text-muted" style={{ fontSize: 'max(0.9rem, 1.2vw)' }}>{label}</p>}
    </div>
  );
}
