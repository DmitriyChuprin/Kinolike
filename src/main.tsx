import { lazy, Suspense } from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { AppLayout, AuthProvider, LoadingPage, NotFoundPage, ProtectedRoute } from './App';
import { ThemeProvider } from './theme';
import './styles.css';
import './glass.css';

const HomePage = lazy(() => import('./pages/HomePage').then(module => ({ default: module.HomePage })));
const CatalogPage = lazy(() => import('./pages/CatalogPage').then(module => ({ default: module.CatalogPage })));
const SearchPage = lazy(() => import('./pages/SearchPage').then(module => ({ default: module.SearchPage })));
const AuthPage = lazy(() => import('./pages/SearchPage').then(module => ({ default: module.AuthPage })));
const DetailPage = lazy(() => import('./pages/DetailPage').then(module => ({ default: module.DetailPage })));
const PersonPage = lazy(() => import('./pages/PersonPage').then(module => ({ default: module.PersonPage })));
const ProfilePage = lazy(() => import('./pages/ProfilePage').then(module => ({ default: module.ProfilePage })));
const ListPage = lazy(() => import('./pages/ListPage').then(module => ({ default: module.ListPage })));
const RecommendationsPage = lazy(() => import('./pages/RecommendationsPage').then(module => ({ default: module.RecommendationsPage })));
const TasteProfilePage = lazy(() => import('./pages/TasteProfilePage').then(module => ({ default: module.TasteProfilePage })));
const StatsPage = lazy(() => import('./pages/StatsPage').then(module => ({ default: module.StatsPage })));
const WrappedPage = lazy(() => import('./pages/StatsPage').then(module => ({ default: module.WrappedPage })));
const AdminUsersPage = lazy(() => import('./pages/AdminUsersPage').then(module => ({ default: module.AdminUsersPage })));

ReactDOM.createRoot(document.getElementById('root')!).render(
  <ThemeProvider><BrowserRouter><AuthProvider><Suspense fallback={<LoadingPage />}><Routes>
    <Route element={<AppLayout />}>
      <Route path="/" element={<HomePage />} />
      <Route path="/catalog" element={<CatalogPage />} />
      <Route path="/search" element={<SearchPage />} />
      <Route path="/movie/:id" element={<DetailPage />} />
      <Route path="/tv/:id" element={<DetailPage />} />
      <Route path="/person/:id" element={<PersonPage />} />
      <Route element={<ProtectedRoute />}>
        <Route path="/want" element={<ListPage />} />
        <Route path="/watched" element={<ListPage watched />} />
        <Route path="/recommendations" element={<RecommendationsPage />} />
        <Route path="/profile" element={<ProfilePage />} />
        <Route path="/admin/users" element={<AdminUsersPage />} />
        <Route path="/taste-profile" element={<TasteProfilePage />} />
        <Route path="/stats" element={<StatsPage />} />
        <Route path="/wrapped/:year" element={<WrappedPage />} />
      </Route>
      <Route path="*" element={<NotFoundPage />} />
    </Route>
    <Route path="/login" element={<AuthPage />} />
    <Route path="/register" element={<AuthPage register />} />
    <Route path="*" element={<Navigate to="/" replace />} />
  </Routes></Suspense></AuthProvider></BrowserRouter></ThemeProvider>,
);
