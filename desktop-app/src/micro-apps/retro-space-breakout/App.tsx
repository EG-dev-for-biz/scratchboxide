import React, { useRef, useEffect, useState, useCallback } from 'react';
import './styles.css';

const CANVAS_WIDTH = 800;
const CANVAS_HEIGHT = 600;

const PADDLE_WIDTH = 100;
const PADDLE_HEIGHT = 15;
const PADDLE_SPEED = 7;

const BALL_RADIUS = 8;
const INITIAL_BALL_SPEED = 5;

const BRICK_ROW_COUNT = 5;
const BRICK_COLUMN_COUNT = 8;
const BRICK_WIDTH = 80;
const BRICK_HEIGHT = 20;
const BRICK_PADDING = 10;
const BRICK_OFFSET_TOP = 30;
const BRICK_OFFSET_LEFT = (CANVAS_WIDTH - (BRICK_COLUMN_COUNT * (BRICK_WIDTH + BRICK_PADDING))) / 2;

interface Brick {
  x: number;
  y: number;
  status: 0 | 1; // 1 for active, 0 for destroyed
}

const App: React.FC = () => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [score, setScore] = useState(0);
  const [lives, setLives] = useState(3);
  const [gameStarted, setGameStarted] = useState(false);
  const [gameOver, setGameOver] = useState(false);
  const [gameWon, setGameWon] = useState(false);

  const paddle = useRef({ x: (CANVAS_WIDTH - PADDLE_WIDTH) / 2, y: CANVAS_HEIGHT - PADDLE_HEIGHT - 10, dx: 0 });
  const ball = useRef({ x: CANVAS_WIDTH / 2, y: CANVAS_HEIGHT - PADDLE_HEIGHT - 10 - BALL_RADIUS, dx: INITIAL_BALL_SPEED, dy: -INITIAL_BALL_SPEED });
  const bricks = useRef<Brick[][]>([]);

  const initializeBricks = useCallback(() => {
    const newBricks: Brick[][] = [];
    for (let c = 0; c < BRICK_COLUMN_COUNT; c++) {
      newBricks[c] = [];
      for (let r = 0; r < BRICK_ROW_COUNT; r++) {
        newBricks[c][r] = { x: 0, y: 0, status: 1 };
      }
    }
    bricks.current = newBricks;
  }, []);

  const resetGame = useCallback(() => {
    paddle.current = { x: (CANVAS_WIDTH - PADDLE_WIDTH) / 2, y: CANVAS_HEIGHT - PADDLE_HEIGHT - 10, dx: 0 };
    ball.current = { x: CANVAS_WIDTH / 2, y: CANVAS_HEIGHT - PADDLE_HEIGHT - 10 - BALL_RADIUS, dx: INITIAL_BALL_SPEED, dy: -INITIAL_BALL_SPEED };
    setScore(0);
    setLives(3);
    setGameStarted(false);
    setGameOver(false);
    setGameWon(false);
    initializeBricks();
  }, [initializeBricks]);

  useEffect(() => {
    initializeBricks();
  }, [initializeBricks]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let animationFrameId: number;

    const drawBall = () => {
      ctx.beginPath();
      ctx.arc(ball.current.x, ball.current.y, BALL_RADIUS, 0, Math.PI * 2);
      ctx.fillStyle = '#ADD8E6'; // Light Blue
      ctx.fill();
      ctx.closePath();
    };

    const drawPaddle = () => {
      ctx.beginPath();
      ctx.rect(paddle.current.x, paddle.current.y, PADDLE_WIDTH, PADDLE_HEIGHT);
      ctx.fillStyle = '#00FF00'; // Green
      ctx.fill();
      ctx.closePath();
    };

    const drawBricks = () => {
      for (let c = 0; c < BRICK_COLUMN_COUNT; c++) {
        for (let r = 0; r < BRICK_ROW_COUNT; r++) {
          const b = bricks.current[c][r];
          if (b.status === 1) {
            const brickX = c * (BRICK_WIDTH + BRICK_PADDING) + BRICK_OFFSET_LEFT;
            const brickY = r * (BRICK_HEIGHT + BRICK_PADDING) + BRICK_OFFSET_TOP;
            b.x = brickX;
            b.y = brickY;
            ctx.beginPath();
            ctx.rect(brickX, brickY, BRICK_WIDTH, BRICK_HEIGHT);
            // Different colors for different rows
            if (r < 1) ctx.fillStyle = '#FF0000'; // Red
            else if (r < 2) ctx.fillStyle = '#FFA500'; // Orange
            else if (r < 3) ctx.fillStyle = '#FFFF00'; // Yellow
            else if (r < 4) ctx.fillStyle = '#0000FF'; // Blue
            else ctx.fillStyle = '#800080'; // Purple
            ctx.fill();
            ctx.closePath();
          }
        }
      }
    };

    const drawScore = () => {
      ctx.font = '16px "Press Start 2P"';
      ctx.fillStyle = '#FFFFFF';
      ctx.fillText(`SCORE: ${score}`, 8, 20);
    };

    const drawLives = () => {
      ctx.font = '16px "Press Start 2P"';
      ctx.fillStyle = '#FFFFFF';
      ctx.fillText(`LIVES: ${lives}`, CANVAS_WIDTH - 100, 20);
    };

    const collisionDetection = () => {
      for (let c = 0; c < BRICK_COLUMN_COUNT; c++) {
        for (let r = 0; r < BRICK_ROW_COUNT; r++) {
          const b = bricks.current[c][r];
          if (b.status === 1) {
            if (
              ball.current.x > b.x &&
              ball.current.x < b.x + BRICK_WIDTH &&
              ball.current.y > b.y &&
              ball.current.y < b.y + BRICK_HEIGHT
            ) {
              ball.current.dy = -ball.current.dy;
              b.status = 0;
              setScore((prev) => prev + 10);
              // Check for win condition
              let allBricksDestroyed = true;
              for (let col = 0; col < BRICK_COLUMN_COUNT; col++) {
                for (let row = 0; row < BRICK_ROW_COUNT; row++) {
                  if (bricks.current[col][row].status === 1) {
                    allBricksDestroyed = false;
                    break;
                  }
                }
                if (!allBricksDestroyed) break;
              }
              if (allBricksDestroyed) {
                setGameWon(true);
                setGameStarted(false);
              }
            }
          }
        }
      }
    };

    const updateGame = () => {
      if (!gameStarted || gameOver || gameWon) return;

      // Move paddle
      paddle.current.x += paddle.current.dx;
      if (paddle.current.x < 0) paddle.current.x = 0;
      if (paddle.current.x + PADDLE_WIDTH > CANVAS_WIDTH) paddle.current.x = CANVAS_WIDTH - PADDLE_WIDTH;

      // Move ball
      ball.current.x += ball.current.dx;
      ball.current.y += ball.current.dy;

      // Wall collision (left/right)
      if (ball.current.x + BALL_RADIUS > CANVAS_WIDTH || ball.current.x - BALL_RADIUS < 0) {
        ball.current.dx = -ball.current.dx;
      }
      // Wall collision (top)
      if (ball.current.y - BALL_RADIUS < 0) {
        ball.current.dy = -ball.current.dy;
      }

      // Ball-paddle collision
      if (
        ball.current.y + BALL_RADIUS > paddle.current.y &&
        ball.current.y - BALL_RADIUS < paddle.current.y + PADDLE_HEIGHT &&
        ball.current.x + BALL_RADIUS > paddle.current.x &&
        ball.current.x - BALL_RADIUS < paddle.current.x + PADDLE_WIDTH
      ) {
        ball.current.dy = -ball.current.dy;
        // Adjust ball speed based on where it hits the paddle
        const hitPoint = ball.current.x - (paddle.current.x + PADDLE_WIDTH / 2);
        ball.current.dx = hitPoint * 0.15; // Max 7.5 for hitPoint 50
      }

      // Ball lost (bottom)
      if (ball.current.y + BALL_RADIUS > CANVAS_HEIGHT) {
        setLives((prev) => prev - 1);
        if (lives - 1 <= 0) {
          setGameOver(true);
          setGameStarted(false);
        } else {
          // Reset ball and paddle position after losing a life
          paddle.current.x = (CANVAS_WIDTH - PADDLE_WIDTH) / 2;
          ball.current.x = CANVAS_WIDTH / 2;
          ball.current.y = CANVAS_HEIGHT - PADDLE_HEIGHT - 10 - BALL_RADIUS;
          ball.current.dx = INITIAL_BALL_SPEED;
          ball.current.dy = -INITIAL_BALL_SPEED;
          setGameStarted(false); // Pause until user restarts
        }
      }

      collisionDetection();
    };

    const gameLoop = () => {
      ctx.clearRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
      ctx.fillStyle = '#000000'; // Black background
      ctx.fillRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);

      drawBricks();
      drawBall();
      drawPaddle();
      drawScore();
      drawLives();

      if (!gameStarted && !gameOver && !gameWon) {
        ctx.font = '24px "Press Start 2P"';
        ctx.fillStyle = '#FFFFFF';
        ctx.textAlign = 'center';
        ctx.fillText('PRESS SPACE TO START', CANVAS_WIDTH / 2, CANVAS_HEIGHT / 2);
      } else if (gameOver) {
        ctx.font = '48px "Press Start 2P"';
        ctx.fillStyle = '#FF0000';
        ctx.textAlign = 'center';
        ctx.fillText('GAME OVER', CANVAS_WIDTH / 2, CANVAS_HEIGHT / 2 - 30);
        ctx.font = '24px "Press Start 2P"';
        ctx.fillStyle = '#FFFFFF';
        ctx.fillText('PRESS R TO RESTART', CANVAS_WIDTH / 2, CANVAS_HEIGHT / 2 + 20);
      } else if (gameWon) {
        ctx.font = '48px "Press Start 2P"';
        ctx.fillStyle = '#00FF00';
        ctx.textAlign = 'center';
        ctx.fillText('YOU WIN!', CANVAS_WIDTH / 2, CANVAS_HEIGHT / 2 - 30);
        ctx.font = '24px "Press Start 2P"';
        ctx.fillStyle = '#FFFFFF';
        ctx.fillText('PRESS R TO RESTART', CANVAS_WIDTH / 2, CANVAS_HEIGHT / 2 + 20);
      }

      updateGame();
      animationFrameId = requestAnimationFrame(gameLoop);
    };

    const keyDownHandler = (e: KeyboardEvent) => {
      if (e.key === 'Right' || e.key === 'ArrowRight') {
        paddle.current.dx = PADDLE_SPEED;
      } else if (e.key === 'Left' || e.key === 'ArrowLeft') {
        paddle.current.dx = -PADDLE_SPEED;
      } else if (e.key === ' ' && !gameStarted && !gameOver && !gameWon) {
        setGameStarted(true);
      } else if (e.key === 'r' && (gameOver || gameWon)) {
        resetGame();
      }
    };

    const keyUpHandler = (e: KeyboardEvent) => {
      if (e.key === 'Right' || e.key === 'ArrowRight' || e.key === 'Left' || e.key === 'ArrowLeft') {
        paddle.current.dx = 0;
      }
    };

    document.addEventListener('keydown', keyDownHandler);
    document.addEventListener('keyup', keyUpHandler);

    animationFrameId = requestAnimationFrame(gameLoop);

    return () => {
      cancelAnimationFrame(animationFrameId);
      document.removeEventListener('keydown', keyDownHandler);
      document.removeEventListener('keyup', keyUpHandler);
    };
  }, [gameStarted, gameOver, gameWon, lives, score, resetGame]);

  return (
    <div className="game-container">
      <h1>Retro Breakout</h1>
      <canvas ref={canvasRef} width={CANVAS_WIDTH} height={CANVAS_HEIGHT} />
      <p>Use LEFT/RIGHT arrow keys to move the paddle.</p>
      <p>Press SPACE to start the game.</p>
      <p>Press R to restart after Game Over or Win.</p>
    </div>
  );
};

export default App;
