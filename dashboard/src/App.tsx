import React, { useState, useEffect } from 'react';
import { 
  CheckCircle2, 
  XCircle, 
  Clock, 
  MapPin, 
  ShieldAlert, 
  LogOut, 
  Award,
  Layers,
  Check,
  X,
  Compass,
  Sparkles
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
  const [loginError, setLoginError] = useState<string>('');

  const API_BASE = '/api/v1';

  // Demo Login
  const handleLogin = async () => {
    try {
      setLoading(true);
      setLoginError('');
      const res = await fetch(`${API_BASE}/auth/demo-login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ seed_id: 'admin-1' }),
      });
      const data = await res.json();
      if (data.success) {
        setToken(data.data.token);
        localStorage.setItem('admin_token', data.data.token);
      } else {
        setLoginError(data.error?.message || 'Login failed');
      }
    } catch (err) {
      setLoginError('Network error - cannot reach server');
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
      if (res.status === 401 || res.status === 403) { handleLogout(); return; }
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
    if (loading) return;
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
      if (res.status === 401 || res.status === 403) { handleLogout(); return; }
      if (!res.ok) {
        const data = await res.json();
        console.error('Review failed:', data.error?.message || res.statusText);
        return;
      }
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
      <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#faf9f5', padding: '20px' }}>
        <div className="stitch-panel" style={{ width: '100%', maxWidth: '440px', padding: '40px', textAlign: 'center' }}>
          <div style={{ margin: '0 auto 20px', width: '100px', height: '100px', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <img src="/logo.png" alt="JuanderQuest Logo" style={{ width: '100%', height: 'auto', filter: 'drop-shadow(0 8px 16px rgba(88, 47, 14, 0.15))' }} />
          </div>
          
          <span style={{ fontSize: '11px', fontWeight: 700, letterSpacing: '1.2px', textTransform: 'uppercase', color: '#582f0e', display: 'block', marginBottom: '6px' }}>
            Pangasinan Tourism Verification
          </span>
          <h1 style={{ fontSize: '26px', fontWeight: 800, color: '#582f0e', marginBottom: '8px' }}>
            JuanderQuest Control Room
          </h1>
          <p style={{ color: '#514532', fontSize: '13px', lineHeight: 1.5, marginBottom: '32px' }}>
            Administrator portal for reviewing GPS-backed quest proof and moderating Pangasinan tourism destinations.
          </p>

          {loginError && (
            <p style={{ color: '#bc4749', fontSize: '12px', marginBottom: '12px' }}>{loginError}</p>
          )}
          <button
            onClick={handleLogin}
            disabled={loading}
            style={{
              width: '100%',
              padding: '16px',
              borderRadius: '14px',
              background: loading ? '#e9e8e4' : '#ffb703',
              color: loading ? '#837560' : '#6b4b00',
              fontWeight: 700,
              fontSize: '16px',
              boxShadow: '0 4px 16px rgba(255, 183, 3, 0.3)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: '10px'
            }}
          >
            {loading ? (
              'Authenticating...'
            ) : (
              <>
                <span>Sign In as Pangasinan Admin</span>
                <Sparkles size={18} />
              </>
            )}
          </button>

          <div style={{ marginTop: '28px', fontSize: '11px', color: '#837560' }}>
            PROTOTYPE BUILD V0.4.2 — ADMIN PORTAL
          </div>
        </div>
      </div>
    );
  }

  return (
    <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column', background: '#faf9f5' }}>
      {/* Header */}
      <header className="stitch-panel" style={{ borderRadius: 0, borderTop: 0, borderLeft: 0, borderRight: 0, padding: '16px 32px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', position: 'sticky', top: 0, zIndex: 50 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
          <img src="/logo.png" alt="Logo" style={{ height: '40px', width: 'auto' }} />
          <div>
            <h2 style={{ fontSize: '20px', fontWeight: 800, color: '#582f0e' }}>JuanderQuest Dashboard</h2>
            <p style={{ fontSize: '12px', color: '#514532' }}>Pangasinan Destination Moderation & Verification</p>
          </div>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '20px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', background: '#beead1', padding: '6px 14px', borderRadius: '20px', fontSize: '12px', fontWeight: 700, color: '#436b58' }}>
            <div style={{ width: '8px', height: '8px', borderRadius: '50%', background: '#2d6a4f' }}></div>
            <span>PANGASINAN REGION ACTIVE</span>
          </div>
          <button onClick={handleLogout} style={{ background: 'transparent', color: '#582f0e', display: 'flex', alignItems: 'center', gap: '6px', fontSize: '14px', fontWeight: 600 }}>
            <LogOut size={16} /> Logout
          </button>
        </div>
      </header>

      {/* Container */}
      <main style={{ maxWidth: '1200px', width: '100%', margin: '0 auto', padding: '32px 20px', flex: 1 }}>
        {/* Navigation Tabs */}
        <div style={{ display: 'flex', gap: '12px', marginBottom: '24px', borderBottom: '1px solid #d5c4ac', paddingBottom: '12px' }}>
          <button
            onClick={() => setActiveTab('pending')}
            style={{
              padding: '10px 20px',
              borderRadius: '20px',
              background: activeTab === 'pending' ? '#ffb703' : '#e9e8e4',
              color: activeTab === 'pending' ? '#6b4b00' : '#514532',
              fontWeight: 700,
              fontSize: '13px',
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
              borderRadius: '20px',
              background: activeTab === 'all' ? '#ffb703' : '#e9e8e4',
              color: activeTab === 'all' ? '#6b4b00' : '#514532',
              fontWeight: 700,
              fontSize: '13px',
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
              borderRadius: '20px',
              background: activeTab === 'quests' ? '#ffb703' : '#e9e8e4',
              color: activeTab === 'quests' ? '#6b4b00' : '#514532',
              fontWeight: 700,
              fontSize: '13px',
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
              <div className="stitch-panel" style={{ padding: '48px', textAlign: 'center', color: '#837560' }}>
                <Clock size={40} style={{ opacity: 0.5, marginBottom: '12px' }} />
                <p style={{ fontWeight: 600 }}>No submissions found in this queue.</p>
              </div>
            ) : (
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(350px, 1fr))', gap: '20px' }}>
                {submissions.map((sub) => (
                  <div key={sub.id} className="stitch-card" style={{ padding: '20px', display: 'flex', flexDirection: 'column', justifyContent: 'space-between' }}>
                    <div>
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '12px' }}>
                        <span style={{ fontSize: '11px', fontWeight: 700, color: '#837560' }}>ID: {sub.id.substring(0, 8)}</span>
                        <span
                          style={{
                            padding: '4px 10px',
                            borderRadius: '12px',
                            fontSize: '11px',
                            fontWeight: 700,
                            textTransform: 'uppercase',
                            background:
                              sub.status === 'approved'
                                ? '#beead1'
                                : sub.status === 'rejected'
                                ? 'rgba(188, 71, 73, 0.15)'
                                : 'rgba(255, 183, 3, 0.2)',
                            color:
                              sub.status === 'approved'
                                ? '#2d6a4f'
                                : sub.status === 'rejected'
                                ? '#bc4749'
                                : '#6b4b00',
                          }}
                        >
                          {sub.status === 'pending' ? 'Awaiting Review' : sub.status}
                        </span>
                      </div>

                      <h3 style={{ fontSize: '18px', fontWeight: 800, color: '#582f0e', marginBottom: '6px' }}>{sub.quest_title}</h3>
                      <p style={{ fontSize: '13px', color: '#514532', marginBottom: '16px' }}>Submitted by: <strong style={{ color: '#1b1c1a' }}>{sub.user_name}</strong></p>

                      <div style={{ background: '#efeeea', padding: '14px', borderRadius: '12px', fontSize: '13px', display: 'flex', flexDirection: 'column', gap: '8px', marginBottom: '16px' }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                          <span style={{ color: '#514532' }}>Marker Code:</span>
                          <span style={{ fontFamily: 'monospace', fontWeight: 700, color: '#582f0e' }}>{sub.scanned_marker_code}</span>
                        </div>
                        <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                          <span style={{ color: '#514532' }}>Distance Offset:</span>
                          <span style={{ fontWeight: 700, color: sub.distance_meters <= 200 ? '#2d6a4f' : '#bc4749' }}>
                            {sub.distance_meters}m {sub.distance_meters <= 200 ? '(Valid Radius)' : '(Exceeds Threshold)'}
                          </span>
                        </div>
                      </div>

                      {sub.rejection_reason && (
                        <div style={{ background: 'rgba(188, 71, 73, 0.1)', borderLeft: '3px solid #bc4749', padding: '10px 12px', borderRadius: '6px', fontSize: '12px', color: '#bc4749', marginBottom: '16px' }}>
                          Reason: {sub.rejection_reason}
                        </div>
                      )}
                    </div>

                    {sub.status === 'pending' && (
                      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px', marginTop: '12px' }}>
                        <button
                          onClick={() => handleReview(sub.id, 'approve')}
                          disabled={loading}
                          style={{ padding: '12px', borderRadius: '10px', background: loading ? '#e9e8e4' : '#2d6a4f', color: loading ? '#837560' : '#fff', fontWeight: 700, fontSize: '13px', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '6px', cursor: loading ? 'not-allowed' : 'pointer' }}
                        >
                          <Check size={16} /> Approve
                        </button>

                        <button
                          onClick={() => {
                            setSelectedSub(sub);
                            setShowRejectModal(true);
                          }}
                          disabled={loading}
                          style={{ padding: '12px', borderRadius: '10px', background: 'rgba(188, 71, 73, 0.15)', border: '1px solid #bc4749', color: loading ? '#837560' : '#bc4749', fontWeight: 700, fontSize: '13px', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '6px', cursor: loading ? 'not-allowed' : 'pointer' }}
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
              <div key={q.id} className="stitch-card" style={{ padding: '20px' }}>
                <span style={{ fontSize: '10px', fontWeight: 700, textTransform: 'uppercase', padding: '4px 8px', borderRadius: '6px', background: '#beead1', color: '#436b58', marginBottom: '8px', display: 'inline-block' }}>
                  {q.category}
                </span>
                <h3 style={{ fontSize: '18px', fontWeight: 800, color: '#582f0e', marginBottom: '6px' }}>{q.title}</h3>
                <p style={{ fontSize: '13px', color: '#514532', marginBottom: '14px' }}>{q.location_name}</p>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: '13px', background: '#efeeea', padding: '10px 14px', borderRadius: '10px' }}>
                  <span>Reward: <strong style={{ color: '#7d5800' }}>+{q.reward_points} PTS</strong></span>
                  <span style={{ fontFamily: 'monospace', fontSize: '11px', color: '#582f0e', fontWeight: 700 }}>{q.marker_code}</span>
                </div>
              </div>
            ))}
          </div>
        )}
      </main>

      {/* Reject Reason Modal */}
      {showRejectModal && selectedSub && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(13, 27, 42, 0.6)', backdropFilter: 'blur(6px)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '20px', zIndex: 100 }}>
          <div className="stitch-panel" style={{ width: '100%', maxWidth: '440px', padding: '28px' }}>
            <h3 style={{ fontSize: '20px', fontWeight: 800, marginBottom: '12px', color: '#bc4749' }}>Reject Quest Submission</h3>
            <p style={{ fontSize: '14px', color: '#514532', marginBottom: '16px' }}>
              Please state the reason for rejecting <strong>{selectedSub.user_name}</strong>'s proof:
            </p>
            <textarea
              rows={4}
              value={rejectionReason}
              onChange={(e) => setRejectionReason(e.target.value)}
              placeholder="e.g., GPS distance offset exceeded maximum radius threshold."
              style={{ width: '100%', background: '#faf9f5', border: '1px solid #d5c4ac', borderRadius: '10px', padding: '12px', color: '#1b1c1a', fontSize: '14px', marginBottom: '20px' }}
            />
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px' }}>
              <button
                onClick={() => {
                  setShowRejectModal(false);
                  setRejectionReason('');
                }}
                style={{ padding: '10px 16px', borderRadius: '10px', background: '#e9e8e4', color: '#514532', fontWeight: 600 }}
              >
                Cancel
              </button>
              <button
                onClick={() => handleReview(selectedSub.id, 'reject', rejectionReason || 'GPS distance threshold exceeded.')}
                style={{ padding: '10px 16px', borderRadius: '10px', background: '#bc4749', color: '#fff', fontWeight: 700 }}
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
