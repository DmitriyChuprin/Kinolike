import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { TrailerPlayer } from './TrailerPlayer';

describe('TrailerPlayer', () => {
  it('renders a safe fallback for a nullable embed URL', () => {
    render(<TrailerPlayer mediaType="movie" tmdbId={1} trailer={{ source: 'youtube', url: 'https://youtube.com/watch?v=1', embedUrl: null, official: true, score: 1 }} onTrailerChange={() => undefined} />);
    expect(screen.getByRole('status')).toHaveTextContent('Трейлер не найден');
    expect(document.querySelector('iframe')).toBeNull();
  });
});
