import React, { useEffect, useRef, useState } from 'react';
import { fetchAuthorizedAudioBlob } from '../utils/api';

interface AuthorizedAudioProps
  extends Omit<React.AudioHTMLAttributes<HTMLAudioElement>, 'src'> {
  src?: string | null;
  onAuthError?: (error: Error) => void;
}

export const AuthorizedAudio = React.forwardRef<HTMLAudioElement, AuthorizedAudioProps>(
  ({ src, onAuthError, ...rest }, ref) => {
    const [resolvedSrc, setResolvedSrc] = useState<string | undefined>(() => {
      if (!src) return undefined;
      return src.startsWith('blob:') || src.startsWith('data:') ? src : undefined;
    });
    const onAuthErrorRef = useRef(onAuthError);
    onAuthErrorRef.current = onAuthError;

    useEffect(() => {
      if (!src) {
        setResolvedSrc(undefined);
        return;
      }

      if (src.startsWith('blob:') || src.startsWith('data:')) {
        setResolvedSrc(src);
        return;
      }

      setResolvedSrc(undefined);
      const controller = new AbortController();
      let objectUrl: string | null = null;

      fetchAuthorizedAudioBlob(src, controller.signal)
        .then((blob) => {
          if (controller.signal.aborted) return;
          objectUrl = URL.createObjectURL(blob);
          setResolvedSrc(objectUrl);
        })
        .catch((err: unknown) => {
          if (controller.signal.aborted) return;
          setResolvedSrc(undefined);
          if (onAuthErrorRef.current) {
            onAuthErrorRef.current(
              err instanceof Error ? err : new Error('Failed to load audio stream.')
            );
          }
        });

      return () => {
        controller.abort();
        if (objectUrl) {
          URL.revokeObjectURL(objectUrl);
        }
      };
    }, [src]);

    return <audio ref={ref} src={resolvedSrc} {...rest} />;
  }
);

AuthorizedAudio.displayName = 'AuthorizedAudio';
