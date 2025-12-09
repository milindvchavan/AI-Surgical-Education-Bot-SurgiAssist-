import React, { useEffect, useRef } from 'react';

interface AudioVisualizerProps {
  isActive: boolean;
  barColor?: string;
}

const AudioVisualizer: React.FC<AudioVisualizerProps> = ({ isActive, barColor = '#3b82f6' }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const animationRef = useRef<number>();

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // Set canvas size
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
    ctx.scale(dpr, dpr);

    const barCount = 30;
    const barWidth = rect.width / barCount;
    const centerY = rect.height / 2;

    let phase = 0;

    const animate = () => {
      ctx.clearRect(0, 0, rect.width, rect.height);
      
      for (let i = 0; i < barCount; i++) {
        // Create a fake wave effect if active, otherwise flat line
        let amplitude = 0;
        
        if (isActive) {
            // Mix of sine waves to create "voice-like" movement
            const wave1 = Math.sin(phase + i * 0.2) * 15;
            const wave2 = Math.sin(phase * 1.5 + i * 0.5) * 10;
            const noise = Math.random() * 5; 
            amplitude = Math.max(2, Math.abs(wave1 + wave2 + noise));
        } else {
            amplitude = 2;
        }

        const height = amplitude;
        const x = i * barWidth;
        const y = centerY - height / 2;

        ctx.fillStyle = barColor;
        ctx.beginPath();
        ctx.roundRect(x + 2, y, barWidth - 4, height, 4);
        ctx.fill();
      }

      phase += 0.15;
      animationRef.current = requestAnimationFrame(animate);
    };

    animate();

    return () => {
      if (animationRef.current) {
        cancelAnimationFrame(animationRef.current);
      }
    };
  }, [isActive, barColor]);

  return (
    <canvas 
      ref={canvasRef} 
      className="w-full h-32 rounded-lg bg-slate-50 border border-slate-100"
    />
  );
};

export default AudioVisualizer;
