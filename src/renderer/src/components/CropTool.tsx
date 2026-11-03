import { Button, Group, Stack, Text } from '@mantine/core';
import { IconCrop } from '@tabler/icons-react';
import { useRef, useState, type PointerEvent } from 'react';
import { call } from '../api';
import { imageUrl, notifyError } from '../lib';
import { cropImage } from '../pdf';

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Shows the source page beside an imported MCQ. Drag a box over a diagram, then attach it to
 * the question or an option.
 */
export function CropTool({
  pageRef,
  targets,
  onAttach,
}: {
  pageRef: string;
  targets: string[];
  onAttach: (target: number, ref: string, size: { width: number; height: number }) => void;
}) {
  const imgRef = useRef<HTMLImageElement>(null);
  const [start, setStart] = useState<{ x: number; y: number } | null>(null);
  const [rect, setRect] = useState<Rect | null>(null);
  const [busy, setBusy] = useState(false);

  const point = (e: PointerEvent): { x: number; y: number } => {
    const box = imgRef.current!.getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(box.width, e.clientX - box.left)),
      y: Math.max(0, Math.min(box.height, e.clientY - box.top)),
    };
  };

  const attach = async (target: number): Promise<void> => {
    const img = imgRef.current;
    if (!img || !rect || rect.w < 4 || rect.h < 4) return;
    setBusy(true);
    try {
      const scale = img.naturalWidth / img.clientWidth;
      const crop = await cropImage(imageUrl(pageRef), {
        x: rect.x * scale,
        y: rect.y * scale,
        width: rect.w * scale,
        height: rect.h * scale,
      });
      const { ref } = await call('images:put', {
        bytes: crop.bytes,
        width: Math.min(crop.width, 480),
        height: Math.round((crop.height * Math.min(crop.width, 480)) / crop.width),
      });
      onAttach(target, ref, { width: crop.width, height: crop.height });
      setRect(null);
    } catch (error) {
      notifyError(error, 'The crop could not be attached');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Stack gap="xs">
      <Text size="sm" c="dimmed">
        Source page. Drag a box over a diagram to crop it.
      </Text>
      <div
        className="page-image-wrap"
        onPointerDown={(e) => {
          (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
          const p = point(e);
          setStart(p);
          setRect({ x: p.x, y: p.y, w: 0, h: 0 });
        }}
        onPointerMove={(e) => {
          if (!start) return;
          const p = point(e);
          setRect({
            x: Math.min(start.x, p.x),
            y: Math.min(start.y, p.y),
            w: Math.abs(p.x - start.x),
            h: Math.abs(p.y - start.y),
          });
        }}
        onPointerUp={() => setStart(null)}
      >
        <img
          ref={imgRef}
          src={imageUrl(pageRef)}
          alt="Source page"
          draggable={false}
          crossOrigin="anonymous"
        />
        {rect && rect.w > 0 ? (
          <div
            className="crop-rect"
            style={{ left: rect.x, top: rect.y, width: rect.w, height: rect.h }}
          />
        ) : null}
      </div>
      {rect && rect.w > 4 && rect.h > 4 ? (
        <Group gap="xs">
          <IconCrop size={16} aria-hidden />
          {targets.map((label, i) => (
            <Button
              key={label}
              size="xs"
              variant="light"
              loading={busy}
              onClick={() => void attach(i)}
            >
              Attach to {label}
            </Button>
          ))}
        </Group>
      ) : null}
    </Stack>
  );
}
