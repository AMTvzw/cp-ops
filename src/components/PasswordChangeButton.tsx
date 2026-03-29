import React, { useState } from 'react';
import { Eye, EyeOff, KeyRound } from 'lucide-react';
import { motion } from 'motion/react';
import { useUser } from '../contexts/UserContext';

interface PasswordChangeButtonProps {
  className?: string;
  label?: string;
}

export default function PasswordChangeButton({
  className = 'bg-white border border-slate-200 text-slate-600 px-4 py-2 rounded-lg hover:bg-slate-50 transition-colors text-sm font-medium',
  label,
}: PasswordChangeButtonProps) {
  const { settings, t } = useUser();
  const [open, setOpen] = useState(false);
  const [oldPassword, setOldPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showOld, setShowOld] = useState(false);
  const [showNew, setShowNew] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const resetForm = () => {
    setOldPassword('');
    setNewPassword('');
    setConfirmPassword('');
    setShowOld(false);
    setShowNew(false);
    setShowConfirm(false);
    setSaving(false);
    setError('');
  };

  const close = () => {
    setOpen(false);
    resetForm();
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');

    if (newPassword.length < 6) {
      setError(t('password.error.short'));
      return;
    }
    if (newPassword !== confirmPassword) {
      setError(t('password.error.match'));
      return;
    }

    setSaving(true);
    try {
      const res = await fetch('/api/users/me/password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          old_password: oldPassword,
          new_password: newPassword,
        }),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => null);
        setError(data?.error || t('password.error.failed'));
        return;
      }

      close();
      alert(t('password.success'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <button type="button" onClick={() => setOpen(true)} className={className}>
        <span className="inline-flex items-center gap-2">
          <KeyRound className="w-4 h-4" />
          {label || t('password.button')}
        </span>
      </button>

      {open && (
        <div className="fixed inset-0 bg-black/50 backdrop-blur-sm flex items-center justify-center p-4 z-50">
          <motion.div
            initial={{ scale: 0.95, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            className="bg-white rounded-2xl p-6 w-full max-w-md shadow-2xl max-h-[90vh] overflow-y-auto"
          >
            <h2 className="text-2xl font-bold mb-6">{t('password.changeTitle')}</h2>
            <form onSubmit={handleSubmit} className="space-y-4">
              {error && (
                <div className="p-3 bg-red-50 border border-red-100 text-red-700 rounded-lg text-sm">
                  {error}
                </div>
              )}

              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">{t('password.old')}</label>
                <div className="relative">
                  <input
                    type={showOld ? 'text' : 'password'}
                    required
                    value={oldPassword}
                    onChange={(e) => setOldPassword(e.target.value)}
                    className="w-full px-4 py-2 pr-11 rounded-lg border border-slate-200 focus:ring-2 focus:ring-blue-500 outline-none"
                  />
                  <button
                    type="button"
                    onClick={() => setShowOld(v => !v)}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-500 hover:text-slate-700"
                    aria-label={showOld ? t('password.aria.hide') : t('password.aria.show')}
                  >
                    {showOld ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                  </button>
                </div>
              </div>

              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">{t('password.new')}</label>
                <div className="relative">
                  <input
                    type={showNew ? 'text' : 'password'}
                    required
                    value={newPassword}
                    onChange={(e) => setNewPassword(e.target.value)}
                    className="w-full px-4 py-2 pr-11 rounded-lg border border-slate-200 focus:ring-2 focus:ring-blue-500 outline-none"
                  />
                  <button
                    type="button"
                    onClick={() => setShowNew(v => !v)}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-500 hover:text-slate-700"
                    aria-label={showNew ? t('password.aria.hide') : t('password.aria.show')}
                  >
                    {showNew ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                  </button>
                </div>
              </div>

              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">{t('password.confirm')}</label>
                <div className="relative">
                  <input
                    type={showConfirm ? 'text' : 'password'}
                    required
                    value={confirmPassword}
                    onChange={(e) => setConfirmPassword(e.target.value)}
                    className="w-full px-4 py-2 pr-11 rounded-lg border border-slate-200 focus:ring-2 focus:ring-blue-500 outline-none"
                  />
                  <button
                    type="button"
                    onClick={() => setShowConfirm(v => !v)}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-500 hover:text-slate-700"
                    aria-label={showConfirm ? t('password.aria.hide') : t('password.aria.show')}
                  >
                    {showConfirm ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                  </button>
                </div>
              </div>

              <div className="flex flex-col sm:flex-row gap-3 mt-6">
                <button
                  type="button"
                  onClick={close}
                  className="flex-1 px-4 py-2 border border-slate-200 rounded-lg text-slate-600 hover:bg-slate-50"
                >
                  {t('common.cancel')}
                </button>
                <button
                  type="submit"
                  disabled={saving}
                  className="flex-1 px-4 py-2 text-white rounded-lg disabled:opacity-60"
                  style={{ backgroundColor: settings.primary_color }}
                >
                  {saving ? t('password.saving') : t('password.save')}
                </button>
              </div>
            </form>
          </motion.div>
        </div>
      )}
    </>
  );
}
