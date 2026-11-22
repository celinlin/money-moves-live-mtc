import { lazy, Suspense } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { FullPageSpinner } from '@/components/ui/misc';
import { supabaseConfigured } from '@/lib/supabase';
import JoinPage from '@/pages/JoinPage';
import PlayPage from '@/pages/PlayPage';
import NotFoundPage from '@/pages/NotFoundPage';
import SetupRequiredPage from '@/pages/SetupRequiredPage';

// Presenter and stage code is split out: phones only download the participant bundle.
const StagePage = lazy(() => import('@/pages/StagePage'));
const HostLayout = lazy(() => import('@/pages/host/HostLayout'));
const HostDashboard = lazy(() => import('@/pages/host/HostDashboard'));
const QuizLibraryPage = lazy(() => import('@/pages/host/QuizLibraryPage'));
const QuizEditorPage = lazy(() => import('@/pages/host/QuizEditorPage'));
const HostSessionPage = lazy(() => import('@/pages/host/HostSessionPage'));
const SessionHistoryPage = lazy(() => import('@/pages/host/SessionHistoryPage'));
const SessionResultsPage = lazy(() => import('@/pages/host/SessionResultsPage'));

export default function App() {
  if (!supabaseConfigured) return <SetupRequiredPage />;
  return (
    <Suspense fallback={<FullPageSpinner />}>
      <Routes>
        <Route path="/" element={<JoinPage />} />
        <Route path="/play/:sessionCode" element={<PlayPage />} />
        <Route path="/stage/:sessionCode" element={<StagePage />} />
        <Route path="/host" element={<HostLayout />}>
          <Route index element={<HostDashboard />} />
          <Route path="quizzes" element={<QuizLibraryPage />} />
          <Route path="quizzes/:quizId/edit" element={<QuizEditorPage />} />
          <Route path="sessions" element={<SessionHistoryPage />} />
          <Route path="sessions/:sessionId/results" element={<SessionResultsPage />} />
        </Route>
        <Route path="/host/session/:sessionId" element={<HostSessionPage />} />
        <Route path="/join" element={<Navigate to="/" replace />} />
        <Route path="*" element={<NotFoundPage />} />
      </Routes>
    </Suspense>
  );
}
