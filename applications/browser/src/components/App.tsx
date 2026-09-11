import React, { useState } from 'react';
import { Sparkles, Play, CheckCircle2 } from 'lucide-react';
import confetti from 'canvas-confetti';

export default function App() {
  const [count, setCount] = useState(0);

  const handleCelebrate = () => {
    setCount(prev => prev + 1);
    confetti({
      particleCount: 80,
      spread: 70,
      origin: { y: 0.6 }
    });
    console.log('Celebration action triggered! Count:', count + 1);
  };

  return (
    <div className="flex flex-col items-center justify-center min-h-screen p-6 bg-zinc-950 text-zinc-100 selection:bg-blue-500 selection:text-white">
      <div className="w-full max-w-md p-8 bg-zinc-900/80 backdrop-blur-xl border border-zinc-800/80 rounded-3xl shadow-2xl space-y-6 text-center">
        <div className="inline-flex p-3 rounded-2xl bg-blue-500/10 text-blue-400 border border-blue-500/20 shadow-inner">
          <Sparkles className="w-8 h-8 animate-pulse" />
        </div>
        
        <div className="space-y-2">
          <h1 className="text-2xl font-bold tracking-tight bg-gradient-to-r from-zinc-100 via-zinc-200 to-zinc-400 bg-clip-text text-transparent">
            Scratchbox Live UI Sandbox
          </h1>
          <p className="text-sm text-zinc-400">
            Interactive React 19 + Tailwind CSS playground with hot reload and live console streams.
          </p>
        </div>

        <div className="p-4 bg-zinc-950/60 rounded-2xl border border-zinc-800/50 flex items-center justify-around">
          <div>
            <div className="text-xs text-zinc-500 font-medium">Interactions</div>
            <div className="text-3xl font-extrabold text-blue-400">{count}</div>
          </div>
          <div className="h-8 w-px bg-zinc-800"></div>
          <div>
            <div className="text-xs text-zinc-500 font-medium">Status</div>
            <div className="text-sm font-semibold text-emerald-400 flex items-center gap-1 mt-1">
              <CheckCircle2 className="w-4 h-4" /> Live
            </div>
          </div>
        </div>

        <button
          onClick={handleCelebrate}
          className="sb-btn sb-btn-primary w-full py-3.5 px-6 rounded-xl font-semibold bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-500 hover:to-indigo-500 text-white shadow-lg shadow-blue-500/25 active:scale-[0.98] transition-all flex items-center justify-center gap-2 group"
        >
          <Play className="w-4 h-4 fill-current transition-transform group-hover:translate-x-0.5" />
          <span>Trigger Interactive Action</span>
        </button>
      </div>
    </div>
  );
}