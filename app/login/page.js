import { Suspense } from 'react';
import AuthForm from '@/components/AuthForm';

export const metadata = {
  title: 'Login - Open Generative AI',
};

export default function LoginPage() {
  return (
    <Suspense>
      <AuthForm />
    </Suspense>
  );
}
