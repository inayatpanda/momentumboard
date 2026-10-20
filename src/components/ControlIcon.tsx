const ControlIcon = ({ path }: { path: string }) => <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={path} /></svg>
export const IconCheck = () => <ControlIcon path="M5 12l4 4L19 6" />
export const IconPlus = () => <ControlIcon path="M12 5v14M5 12h14" />
export const IconClose = () => <ControlIcon path="M6 6l12 12M6 18L18 6" />
