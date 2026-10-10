export type MediaType = 'movie' | 'tv';
export type ListStatus = 'want_to_watch' | 'watched' | 'not_interested';

export interface Movie {
  id: number;
  mediaType: MediaType;
  title: string;
  originalTitle?: string;
  year: number;
  duration?: string;
  seasons?: number;
  rating: number;
  votes?: string;
  imdbId?: string;
  imdbRating?: number;
  imdbVotes?: number;
  imdbUpdatedAt?: string;
  genres: string[];
  poster: string;
  posterPath?: string;
  backdrop?: string;
  backdropPath?: string;
  overview?: string;
  tagline?: string;
  director?: string;
  cast?: string[];
  watchedAt?: string;
  userRating?: number;
  status?: ListStatus;
  listId?: number;
  recommendationScore?: number;
  recommendationReason?: string;
  recommendationId?: number;
  structuredReasons?: Record<string, unknown>;
  notes?: string;
  character?: string;
  category?: string;
  workScore?: number;
  canAdd?: boolean;
}

export interface PersonWork {
  credit_id?: number;
  tmdb_id: number | null;
  media_type: MediaType | null;
  imdb_title_id: string | null;
  title: string;
  original_title?: string | null;
  year: number | null;
  end_year?: number | null;
  poster_path?: string | null;
  overview?: string | null;
  genres?: string[];
  category?: string;
  characters?: string;
  job?: string | null;
  imdb_rating?: number | null;
  imdb_votes?: number | null;
  tmdb_rating?: number | null;
  tmdb_vote_count?: number | null;
  tmdb_popularity?: number | null;
  known_for?: boolean;
  status?: ListStatus | null;
  list_id?: number | null;
  work_score: number;
  can_add: boolean;
  source?: 'tmdb' | 'imdb' | 'tmdb+imdb';
}

export interface Genre {
  id: string;
  name: string;
  image: string;
  count?: number;
  href?: string;
}

export interface User {
  id: number;
  username: string;
  email: string;
  avatar_url?: string;
  is_admin: boolean;
  jellyfin_enabled: boolean;
  preferred_streaming_source: 'phantom' | 'videohub';
}

export interface TVShow extends Movie { mediaType: 'tv'; seasons?: number; }

export interface Episode {
  id: string;
  season: number;
  episode: number;
  name: string;
  overview?: string;
  runtime?: number;
}

export interface Person {
  id: number;
  name: string;
  biography?: string;
  birthday?: string | null;
  deathday?: string | null;
  profilePath?: string | null;
  filmography: PersonWork[];
}

export interface Rating { value: number | null; notes?: string; ratedAt?: string; }

export interface WatchProgress {
  tmdbId: number;
  mediaType: MediaType;
  season: number | null;
  episode: number | null;
  position: number;
  duration: number;
  updatedAt: string | null;
}

export interface StreamingSource {
  id: 'jellyfin' | 'phantom' | 'videohub';
  available: boolean;
  title?: string;
  url?: string;
}

export interface Recommendation {
  tmdb_id: number;
  media_type: MediaType;
  recommendation_id?: number;
  score?: number;
  reason?: string;
  structured_reasons?: Record<string, unknown>;
}

export interface Statistics {
  total: number;
  movies: number;
  tv: number;
  avgRating: number;
  estimatedHours?: number;
  recommendationConversion?: number;
}

export interface RankedStatistic { name: string; count: number; }
export interface ExtendedStatistics extends Statistics {
  averageRating: number;
  estimatedHours: number;
  recommendationConversion: number;
  genres: RankedStatistic[];
  monthly: RankedStatistic[];
  directors: RankedStatistic[];
  actors: RankedStatistic[];
  countries: RankedStatistic[];
  decades: RankedStatistic[];
}

export interface WrappedStatistics extends ExtendedStatistics {
  year: number;
  favoriteGenre: RankedStatistic | null;
  favoriteDirector: RankedStatistic | null;
  favoriteActor: RankedStatistic | null;
  mostActiveMonth: RankedStatistic | null;
}

export interface Review {
  id: string;
  author: string;
  username?: string;
  avatarPath?: string;
  rating?: number;
  content: string;
  createdAt?: string;
  url?: string;
}
