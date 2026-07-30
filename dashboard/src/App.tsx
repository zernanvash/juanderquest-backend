import React, { useState, useEffect } from 'react';
import { 
  CheckCircle2, 
  XCircle, 
  Clock, 
  MapPin, 
  Compass, 
  ShieldAlert, 
  Search, 
  LogOut, 
  Sparkles,
  Award,
  Layers,
  Check,
  X
} from 'lucide-react';

interface Submission {
  id: string;
  user_name: string;
  quest_title: string;
  scanned_marker_code: string;
  captured_lat: number;
  captured_lng: number;
  target_lat: number;
  target_lng: number;
  distance_meters: number;
  status: 'pending' | 'approved' | 'rejected';
  rejection_reason?: string;
  created_at: string;
}

interface Quest {
  id: string;
  title: string;
  category: string;
  location_name: string;
  reward_points: number;
  marker_code: string;
}

export function App() {
  const [token, setToken] = useState<string | null>(localStorage.getItem('admin_token'));
  const [activeTab, setActiveTab] = useState<'pending' | 'all' | 'quests'>('pending');
  const [submissions, setSubmissions] = useState<Submission[]>([]);
  const [quests, setQuests] = useState<Quest[]>([]);
  const [loading, setLoading] = useState<boolean>(false);
  const [selectedSub, setSelectedSub] = useState<Submission | null>(null);
  const [rejectionReason, setRejectionReason] = useState<string>('');
  const [showRejectModal, setShowRejectModal] = useState<boolean>(false);

  const API_BASE = '/api/v1';

  // Demo Login
  const handleLogin = async () => {
    try {
      setLoading(true);
      const res = await fetch(`${API_BASE}/auth/demo-login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ seed_id: 'admin-1' }),
      });
      const data = await res.json();
      if (data.success) {
        setToken(data.data.token);
        localStorage.setItem('admin_token', data.data.token);
      }
    } catch (err) {
      console.error('Login error:', err);
    } finally {
      setLoading(false);
    }
  };

  const handleLogout = () => {
    setToken(null);
    localStorage.removeItem('admin_token');
  };

  // Fetch Submissions
  const fetchSubmissions = async () => {
    if (!token) return;
    try {
      setLoading(true);
      const statusQuery = activeTab === 'pending' ? '?status=pending' : '';
      const res = await fetch(`${API_BASE}/admin/submissions${statusQuery}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await res.json();
      if (data.success) {
        setSubmissions(data.data);
      }
    } catch (err) {
      console.error('Fetch submissions error:', err);
    } finally {
      setLoading(false);
    }
  };

  // Fetch Quests
  const fetchQuests = async () => {
    try {
      const res = await fetch(`${API_BASE}/quests`);
      const data = await res.json();
      if (data.success) {
        setQuests(data.data);
      }
    } catch (err) {
      console.error('Fetch quests error:', err);
    }
  };

  useEffect(() => {
    if (token) {
      if (activeTab === 'quests') {
        fetchQuests();
      } else {
        fetchSubmissions();
      }
    }
  }, [token, activeTab]);

  // Review Submission
  const handleReview = async (id: string, action: 'approve' | 'reject', reason?: string) => {
    try {
      setLoading(true);
      const res = await fetch(`${API_BASE}/admin/submissions/${id}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          action,
          rejection_reason: reason,
        }),
      });
      const data = await res.json();
      if (data.success) {
        setShowRejectModal(false);
        setSelectedSub(null);
        setRejectionReason('');
        fetchSubmissions();
      }
    } catch (err) {
      console.error('Review submission error:', err);
    } finally {
      setLoading(false);
    }
  };

  if (!token) {
    return (
      <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'radial-gradient(circle at center, #1a233a 0%, #0a0f1d 100%)', padding: '20px' }}>
        <div className="glass-panel" style={{ width: '100%', maxWidth: '440px', padding: '40px', textAlign: 'center' }}>
          <div style={{ width: '64px', height: '64px', background: 'linear-gradient(135deg, #00f2fe 0%, #4facfe 100%)', borderRadius: '16px', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 20px', boxShadow: '0 8px 32px rgba(0, 242, 254, 0.3)' }}>
            <Compass size={36} color="#0a0f1d" />
          </div>
          <h1 style={{ fontSize: '28px', fontWeight: 700, marginBottom: '8px', background: 'linear-gradient(90deg, #ffffff, #94a3b8)', WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent' }}>
            JuanderQuest Admin
          </h1>
          <p style={{ color: 'var(--text-secondary)', fontSize: '14px', marginBottom: '32px' }}>
            Pangasinan Tourist Destination Verification Portal
          </p>
          <button
            onClick={handleLogin}
            disabled={loading}
            style={{
              width: '100%',
              padding: '14px',
              borderRadius: '12px',
              background: 'linear-gradient(90deg, #00f2fe, #4facfe)',
              color: '#0a0f1d',
              fontWeight: 700,
              fontSize: '16px',
              boxShadow: '0 4px 20px rgba(0, 242, 254, 0.3)',
            }}
          >
            {loading ? 'Authenticating...' : 'Sign In as Pangasinan Admin'}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column' }}>
      {/* Header */}
      <header className="glass-panel" style={{ borderRadius: 0, borderTop: 0, borderLeft: 0, borderRight: 0, padding: '16px 32px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', position: 'sticky', top: 0, zIndex: 50 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
          <div style={{ width: '40px', height: '40px', background: 'linear-gradient(135deg, #00f2fe 0%, #4facfe 100%)', borderRadius: '10px', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <Compass size={24} color="#0a0f1d" />
          </div>
          <div>
            <h2 style={{ fontSize: '18px', fontWeight: 700 }}>JuanderQuest Dashboard</h2>
            <p style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>Verification & Moderation Control Room</p>
          </div>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '20px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', background: 'var(--bg-card)', padding: '6px 14px', borderRadius: '20px', border: '1px solid var(--border-color)', fontSize: '13px' }}>
            <div style={{ width: '8px', height: '8px', borderRadius: '50%', background: 'var(--accent-emerald)' }}></div>
            <span>Admin Active</span>
          </div>
          <button onClick={handleLogout} style={{ background: 'transparent', color: 'var(--text-secondary)', display: 'flex', alignItems: 'center', gap: '6px', fontSize: '14px' }}>
            <LogOut size={16} /> Logout
          </button>
        </div>
      </header>

      {/* Container */}
      <main style={{ maxWidth: '1200px', width: '100%', margin: '0 auto', padding: '32px 20px', flex: 1 }}>
        {/* Navigation Tabs */}
        <div style={{ display: 'flex', gap: '12px', marginBottom: '24px', borderBottom: '1px solid var(--border-color)', paddingBottom: '12px' }}>
          <button
            onClick={() => setActiveTab('pending')}
            style={{
              padding: '10px 20px',
              borderRadius: '10px',
              background: activeTab === 'pending' ? 'linear-gradient(90deg, #00f2fe, #4facfe)' : 'var(--bg-card)',
              color: activeTab === 'pending' ? '#0a0f1d' : 'var(--text-primary)',
              fontWeight: 600,
              fontSize: '14px',
              display: 'flex',
              alignItems: 'center',
              gap: '8px',
            }}
          >
            <Clock size={16} /> Pending Queue
          </button>

          <button
            onClick={() => setActiveTab('all')}
            style={{
              padding: '10px 20px',
              borderRadius: '10px',
              background: activeTab === 'all' ? 'linear-gradient(90deg, #00f2fe, #4facfe)' : 'var(--bg-card)',
              color: activeTab === 'all' ? '#0a0f1d' : 'var(--text-primary)',
              fontWeight: 600,
              fontSize: '14px',
              display: 'flex',
              alignItems: 'center',
              gap: '8px',
            }}
          >
            <Layers size={16} /> All Submissions
          </button>

          <button
            onClick={() => setActiveTab('quests')}
            style={{
              padding: '10px 20px',
              borderRadius: '10px',
              background: activeTab === 'quests' ? 'linear-gradient(90deg, #00f2fe, #4facfe)' : 'var(--bg-card)',
              color: activeTab === 'quests' ? '#0a0f1d' : 'var(--text-primary)',
              fontWeight: 600,
              fontSize: '14px',
              display: 'flex',
              alignItems: 'center',
              gap: '8px',
            }}
          >
            <MapPin size={16} /> Pangasinan Quests
          </button>
        </div>

        {/* Content Section */}
        {activeTab !== 'quests' ? (
          <div>
            {submissions.length === 0 ? (
              <div className="glass-panel" style={{ padding: '48px', textAlign: 'center', color: 'var(--text-secondary)' }}>
                <Clock size={40} style={{ opacity: 0.5, marginBottom: '12px' }} />
                <p>No submissions found in this queue.</p>
              </div>
            ) : (
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(350px, 1fr))', gap: '20px' }}>
                {submissions.map((sub) => (
                  <div key={sub.id} className="glass-card" style={{ padding: '20px', display: 'flex', flexDirection: 'column', justifyContent: 'space-between' }}>
                    <div>
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '12px' }}>
                        <span style={{ fontSize: '12px', fontWeight: 600, color: 'var(--text-muted)' }}>ID: {sub.id.substring(0, 8)}</span>
                        <span
                          style={{
                            padding: '4px 10px',
                            borderRadius: '12px',
                            fontSize: '12px',
                            fontWeight: 700,
                            textTransform: 'uppercase',
                            background:
                              sub.status === 'approved'
                                ? 'rgba(16, 185, 129, 0.15)'
                                : sub.status === 'rejected'
                                ? 'rgba(244, 63, 94, 0.15)'
                                : 'rgba(255, 183, 3, 0.15)',
                            color:
                              sub.status === 'approved'
                                ? 'var(--accent-emerald)'
                                : sub.status === 'rejected'
                                ? 'var(--accent-rose)'
                                : 'var(--accent-gold)',
                          }}
                        >
                          {sub.status}
                        </span>
                      </div>

                      <h3 style={{ fontSize: '18px', fontWeight: 700, marginBottom: '6px' }}>{sub.quest_title}</h3>
                      <p style={{ fontSize: '14px', color: 'var(--text-secondary)', marginBottom: '16px' }}>Submitted by: <strong style={{ color: '#fff' }}>{sub.user_name}</strong></p>

                      <div style={{ background: 'var(--bg-secondary)', padding: '12px', borderRadius: '10px', fontSize: '13px', display: 'flex', flexDirection: 'column', gap: '6px', marginBottom: '16px' }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                          <span style={{ color: 'var(--text-secondary)' }}>Marker Code:</span>
                          <span style={{ fontFamily: 'monospace', color: 'var(--accent-cyan)' }}>{sub.scanned_marker_code}</span>
                        </div>
                        <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                          <span style={{ color: 'var(--text-secondary)' }}>Distance Offset:</span>
                          <span style={{ fontWeight: 700, color: sub.distance_meters <= 200 ? 'var(--accent-emerald)' : 'var(--accent-rose)' }}>
                            {sub.distance_meters}m {sub.distance_meters <= 200 ? '(Valid Radius)' : '(Exceeds Threshold)'}
                          </span>
                        </div>
                      </div>

                      {sub.rejection_reason && (
                        <div style={{ background: 'rgba(244, 63, 94, 0.1)', borderLeft: '3px solid var(--accent-rose)', padding: '8px 12px', borderRadius: '4px', fontSize: '12px', color: 'var(--accent-rose)', marginBottom: '16px' }}>
                          Reason: {sub.rejection_reason}
                        </div>
                      )}
                    </div>

                    {sub.status === 'pending' && (
                      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px', marginTop: '12px' }}>
                        <button
                          onClick={() => handleReview(sub.id, 'approve')}
                          style={{ padding: '10px', borderRadius: '8px', background: 'var(--accent-emerald)', color: '#fff', fontWeight: 700, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '6px' }}
                        >
                          <Check size={16} /> Approve
                        </button>

                        <button
                          onClick={() => {
                            setSelectedSub(sub);
                            setShowRejectModal(true);
                          }}
                          style={{ padding: '10px', borderRadius: '8px', background: 'rgba(244, 63, 94, 0.2)', border: '1px solid var(--accent-rose)', color: 'var(--accent-rose)', fontWeight: 700, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '6px' }}
                        >
                          <X size={16} /> Reject
                        </button>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))', gap: '20px' }}>
            {quests.map((q) => (
              <div key={q.id} className="glass-card" style={{ padding: '20px' }}>
                <span style={{ fontSize: '11px', fontWeight: 700, textTransform: 'uppercase', padding: '3px 8px', borderRadius: '6px', background: 'rgba(0, 242, 254, 0.1)', color: 'var(--accent-cyan)', marginBottom: '8px', display: 'inline-block' }}>
                  {q.category}
                </span>
                <h3 style={{ fontSize: '18px', fontWeight: 700, marginBottom: '6px' }}>{q.title}</h3>
                <p style={{ fontSize: '13px', color: 'var(--text-secondary)', marginBottom: '14px' }}>{q.location_name}</p>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: '13px', background: 'var(--bg-secondary)', padding: '10px', borderRadius: '8px' }}>
                  <span>Reward: <strong>+{q.reward_points} Points</strong></span>
                  <span style={{ fontFamily: 'monospace', fontSize: '11px', color: 'var(--text-muted)' }}>{q.marker_code}</span>
                </div>
              </div>
            ))}
          </div>
        )}
      </main>

      {/* Reject Reason Modal */}
      {showRejectModal && selectedSub && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(10, 15, 29, 0.85)', backdropFilter: 'blur(6px)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '20px', zIndex: 100 }}>
          <div className="glass-panel" style={{ width: '100%', maxWidth: '440px', padding: '28px' }}>
            <h3 style={{ fontSize: '20px', fontWeight: 700, marginBottom: '12px', color: 'var(--accent-rose)' }}>Reject Quest Submission</h3>
            <p style={{ fontSize: '14px', color: 'var(--text-secondary)', marginBottom: '16px' }}>
              Please state the reason for rejecting <strong>{selectedSub.user_name}</strong>'s proof:
            </p>
            <textarea
              rows={4}
              value={rejectionReason}
              onChange={(e) => setRejectionReason(e.target.value)}
              placeholder="e.g., GPS distance offset exceeded maximum radius threshold."
              style={{ width: '100%', background: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: '8px', padding: '12px', color: '#fff', fontSize: '14px', marginBottom: '20px' }}
            />
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px' }}>
              <button
                onClick={() => {
                  setShowRejectModal(false);
                  setRejectionReason('');
                }}
                style={{ padding: '10px 16px', borderRadius: '8px', background: 'var(--bg-card)', color: 'var(--text-secondary)' }}
              >
                Cancel
              </button>
              <button
                onClick={() => handleReview(selectedSub.id, 'reject', rejectionReason || 'GPS distance threshold exceeded.')}
                style={{ padding: '10px 16px', borderRadius: '8px', background: 'var(--accent-rose)', color: '#fff', fontWeight: 700 }}
              >
                Confirm Rejection
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
