import React from 'react';
import { createRoot } from 'react-dom/client';
import { HygieneWorkflowView } from '../../src/features/hygiene/HygieneWorkflow';

// Only the shared mobile view is mounted. No auth, catalog or production API is loaded.
createRoot(document.getElementById('root')!).render(
  <HygieneWorkflowView operator="Camille Martin (test)" />,
);
