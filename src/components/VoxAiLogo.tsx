import React, { useEffect, useState } from 'react';

export interface VoxAiLogoProps {
  theme?: 'light' | 'dark';
  className?: string;
}

function getResolvedDomTheme(): 'light' | 'dark' {
  if (typeof document !== 'undefined') {
    if (document.documentElement.classList.contains('dark')) return 'dark';
    if (document.documentElement.classList.contains('light')) return 'light';
  }
  if (typeof window !== 'undefined' && localStorage.getItem('voxai_theme') === 'dark') {
    return 'dark';
  }
  return 'light';
}

export const VoxAiLogo: React.FC<VoxAiLogoProps> = ({ theme, className = '' }) => {
  const [domTheme, setDomTheme] = useState<'light' | 'dark'>(() => getResolvedDomTheme());

  useEffect(() => {
    if (theme !== undefined || typeof document === 'undefined') return;
    const root = document.documentElement;
    const sync = () => setDomTheme(getResolvedDomTheme());
    sync();

    const observer = new MutationObserver(sync);
    observer.observe(root, { attributes: true, attributeFilter: ['class'] });
    window.addEventListener('storage', sync);

    return () => {
      observer.disconnect();
      window.removeEventListener('storage', sync);
    };
  }, [theme]);

  const activeTheme = theme ?? domTheme;
  const defaultSize = activeTheme === 'dark' ? 'h-8 sm:h-9 md:h-10' : 'h-10 sm:h-11 md:h-12';

  return (
    <img
      src={
        activeTheme === 'dark'
          ? '/assets/aistudio/voxai_dark_mode_logo_ef464d4d.png'
          : '/assets/aistudio/VoxAI_Studio_Gradient_Logo_55b715a4.webp'
      }
      alt="VoxAI Studio"
      className={`block w-auto max-w-full object-contain ${className || defaultSize}`.trim()}
    />
  );
};
