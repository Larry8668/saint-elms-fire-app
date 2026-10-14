import type { DemoPersona, EdgeOrigin, EdgeType, TeacherId } from '@sef/shared';

/** A hand-written concept page. Everything else in a persona's brain is generated from rules. */
export interface HeroPage {
  key: string;
  words: string;
  stuck?: string;
  connections?: string;
  /** Open misconceptions make a node shaky (amber); resolved ones show growth in the history. */
  misconceptions?: Array<{ claim: string; course: string; daysAgo: number; resolved?: boolean }>;
  /** [score, outOf, daysAgo]. Two passes at 70%+ make a node solid; a failing latest quiz makes it shaky. */
  quizzes?: Array<[number, number, number]>;
  /** Session ids from `sessions` that touched this page. */
  sessions?: string[];
  daysAgo: number;
}

export interface SeedLink {
  from: string;
  to: string;
  type: EdgeType;
  origin: EdgeOrigin;
  why: string;
}

export interface SeedSession {
  id: string;
  teacher: TeacherId;
  daysAgo: number;
  turns: Array<[role: 'user' | 'assistant', text: string]>;
}

export interface PersonaScript {
  /** Days before today that this student started Semester 1. */
  startedDaysAgo: number;
  /** Fraction of a course's concepts this student has met, by course id, semester or subject. */
  coverage: (course: { id: string; semesterNumber: number; subjectId: string }) => number;
  /** Of the generated pages: how many end up solid, and how many shaky. The rest are "met". */
  solidRate: number;
  shakyRate: number;
  /** Short, in-voice sentence for generated pages. */
  voice: (concept: string, lesson: string) => string;
  heroes: HeroPage[];
  links: SeedLink[];
  sessions: SeedSession[];
}

const SEMESTER_DAYS = 160;

export const semesterStartDaysAgo = (script: PersonaScript, semester: number) =>
  Math.max(0, script.startedDaysAgo - (semester - 1) * SEMESTER_DAYS);

const ananya: PersonaScript = {
  startedDaysAgo: 42,
  coverage: ({ id }) =>
    ({ mechanics: 0.6, 'bridge-physics': 0.5, 'differential-calculus': 0.3, 'mechanics-lab': 0.2 } as Record<string, number>)[id] ?? 0,
  solidRate: 0.15,
  shakyRate: 0.06,
  voice: (concept, lesson) => `Met ${concept} in "${lesson}". I drew a little sketch of it so I'd remember.`,
  heroes: [
    {
      key: 'newton-s-first-law',
      words: 'Things keep doing what they are doing unless a net force changes it. A puck on ice slides for ages because almost nothing pushes back.',
      stuck: 'In real life everything stops eventually, so it *feels* like moving things need a push to keep going.',
      misconceptions: [
        {
          claim: 'If nothing pushes an object it slows down and stops on its own.',
          course: 'An object keeps constant velocity unless a net force acts. Friction is the force that slows it.',
          daysAgo: 9,
        },
      ],
      sessions: ['ananya-guide-first-law'],
      daysAgo: 9,
    },
    {
      key: 'newton-s-second-law',
      words: 'F = ma. A bigger net force gives a bigger *acceleration*, not a bigger speed.',
      stuck: 'I keep writing "more force → faster". The Guide asked what happens to a car cruising at constant speed and I said "no force", which was right, but then I contradicted myself on the next question.',
      quizzes: [[2, 3, 12], [1, 3, 4]],
      sessions: ['ananya-guide-first-law'],
      daysAgo: 4,
    },
    {
      key: 'free-body-diagram',
      words: 'Draw the box. Draw an arrow for everything *touching* it, then gravity. Only then write equations.',
      connections: 'Normal force only shows up when something is touching, which is why I list contacts first.',
      quizzes: [[3, 3, 10]],
      daysAgo: 10,
    },
    {
      key: 'centripetal-acceleration',
      words: 'Going round in a circle at constant speed still counts as accelerating, because the direction keeps changing.',
      misconceptions: [
        {
          claim: 'On a curve, centrifugal force pushes the car outward.',
          course: 'In the ground frame there is no outward force; friction supplies the inward (centripetal) force.',
          daysAgo: 3,
        },
      ],
      sessions: ['ananya-guide-circular'],
      daysAgo: 3,
    },
    {
      key: 'static-friction',
      words: 'Friction that stops something from starting to slide.',
      misconceptions: [
        {
          claim: 'Static friction is always μN.',
          course: 'Static friction matches the applied force up to a maximum of μₛN; μN is only the limit.',
          daysAgo: 6,
        },
      ],
      quizzes: [[1, 3, 6]],
      daysAgo: 6,
    },
    {
      key: 'newton-s-third-law',
      words: 'Forces come in pairs acting on *different* bodies, so they never cancel each other out.',
      stuck: 'I used to think action and reaction cancel. They act on different objects, so they can\'t.',
      misconceptions: [
        {
          claim: 'Action and reaction cancel, so nothing should move.',
          course: 'The pair acts on different bodies; cancellation only applies to forces on the same body.',
          daysAgo: 14,
          resolved: true,
        },
      ],
      quizzes: [[3, 3, 8]],
      daysAgo: 8,
    },
    {
      key: 'projectile-motion',
      words: 'Horizontal and vertical are two separate stories that share one clock.',
      quizzes: [[3, 3, 15], [4, 4, 5]],
      daysAgo: 5,
    },
    {
      key: 'derivative',
      words: 'The slope of the tangent line, i.e. how fast something is changing right now.',
      connections: 'Velocity is the derivative of position, which is the first time maths and mechanics clicked together for me.',
      daysAgo: 7,
    },
  ],
  links: [
    { from: 'free-body-diagram', to: 'normal-force', type: 'related_to', origin: 'student', why: 'Contacts give normal forces' },
    { from: 'projectile-motion', to: 'vector-independence', type: 'builds_upon', origin: 'student', why: 'x and y move independently' },
    { from: 'derivative', to: 'velocity-vector', type: 'related_to', origin: 'student', why: 'Velocity is the derivative of position' },
    { from: 'free-body-diagram', to: 'static-friction', type: 'related_to', origin: 'peer', why: "From Rohan's checklist share" },
  ],
  sessions: [
    {
      id: 'ananya-guide-first-law',
      teacher: 'guide',
      daysAgo: 9,
      turns: [
        ['user', 'Why does a ball rolling on the floor stop if no force is acting on it?'],
        ['assistant', "Good question to sit with. Before I answer: is it really true that *no* force acts on it? What is the ball touching while it rolls?"],
        ['user', 'The floor... and air I guess. So the floor pushes back?'],
        ['assistant', 'Exactly. The floor and the air both exert forces that oppose the motion. So does Newton\'s first law say things stop on their own, or that something has to stop them?'],
        ['user', 'Something has to stop them. But it still feels like moving needs a push.'],
      ],
    },
    {
      id: 'ananya-guide-circular',
      teacher: 'guide',
      daysAgo: 3,
      turns: [
        ['user', 'When a car turns, what pushes me against the door?'],
        ['assistant', "Let's look at it from the road. Which way does the car accelerate on a curve, towards the centre or away from it?"],
        ['user', 'Away? Because I get thrown outward.'],
      ],
    },
  ],
};

const brinda: PersonaScript = {
  startedDaysAgo: 430,
  coverage: ({ semesterNumber, subjectId }) => {
    const base = ({ 1: 0.92, 2: 0.85, 3: 0.7 } as Record<number, number>)[semesterNumber] ?? 0;
    return subjectId === 'mathematics' ? Math.min(1, base + 0.06) : base;
  },
  solidRate: 0.62,
  shakyRate: 0.006,
  voice: (concept, lesson) => `Wrote out ${concept} from "${lesson}" and checked it against a worked example.`,
  heroes: [
    {
      key: 'newton-s-second-law',
      words: 'F = dp/dt. When mass is constant that reduces to ma, so the derivative is doing all the work.',
      connections: 'Rocket problems only make sense with the dp/dt form, because the mass changes.',
      quizzes: [[3, 3, 400], [4, 4, 380], [3, 3, 120]],
      daysAgo: 120,
    },
    {
      key: 'centripetal-acceleration',
      words: 'a = v²/r towards the centre. I derived it from the change in the velocity vector over a small angle.',
      misconceptions: [
        {
          claim: 'Centrifugal force acts outward on a turning car.',
          course: 'In an inertial frame only the inward net force exists.',
          daysAgo: 410,
          resolved: true,
        },
      ],
      quizzes: [[2, 3, 405], [3, 3, 395], [4, 4, 300]],
      daysAgo: 300,
    },
    {
      key: 'coriolis-force',
      words: 'Shows up in a rotating frame and depends on velocity: 2m(v × ω).',
      stuck: "I still can't predict the direction without drawing the cross product out.",
      quizzes: [[3, 4, 390], [1, 3, 30]],
      daysAgo: 30,
    },
    {
      key: 'work',
      words: 'W = ∫F·dx. For a constant force that is just F·d.',
      connections: 'This is exactly the "work as a definite integral" example from Integral Calculus.',
      quizzes: [[3, 3, 390], [4, 4, 260]],
      daysAgo: 260,
    },
    {
      key: 'varepsilon-delta-definition',
      words: 'A contract: for every ε a sceptic picks, I must find a δ that keeps f(x) within ε.',
      quizzes: [[2, 3, 400], [3, 3, 360], [4, 4, 70]],
      daysAgo: 70,
    },
    {
      key: 'uniform-continuity',
      words: 'The same δ has to work everywhere on the set, not a new one for each point.',
      connections: 'Heine–Cantor: on a closed interval, continuous implies uniformly continuous. Compactness is what makes it work.',
      quizzes: [[3, 3, 40], [3, 3, 20]],
      daysAgo: 20,
    },
    {
      key: 'simple-harmonic-motion',
      words: "x'' = −ω²x. Every SHM problem is the same ODE in a different costume.",
      quizzes: [[4, 4, 60], [3, 3, 25]],
      daysAgo: 25,
    },
    {
      key: 'conservation-of-mechanical-energy',
      words: 'If every force is conservative, KE + PE stays constant.',
      connections: 'Conservative ⇔ path-independent ⇔ the curl is zero. That last one comes from Differential Equations (exact equations).',
      quizzes: [[3, 3, 380], [4, 4, 200]],
      daysAgo: 200,
    },
  ],
  links: [
    { from: 'newton-s-second-law', to: 'derivative', type: 'builds_upon', origin: 'student', why: 'F = dp/dt is a derivative' },
    { from: 'work', to: 'work-as-a-definite-integral', type: 'related_to', origin: 'student', why: 'Same idea, two courses' },
    { from: 'work', to: 'definite-integral', type: 'builds_upon', origin: 'student', why: 'W = ∫F·dx' },
    { from: 'simple-harmonic-motion', to: 'linear-ode-with-constant-coefficient', type: 'builds_upon', origin: 'student', why: "x'' + ω²x = 0" },
    { from: 'simple-harmonic-motion', to: 'small-angle-approximation', type: 'related_to', origin: 'student', why: 'Pendulum → SHM only for small θ' },
    { from: 'conservation-of-mechanical-energy', to: 'conservative-vector-field', type: 'related_to', origin: 'student', why: 'Path independence' },
    { from: 'conservative-force', to: 'path-independence', type: 'builds_upon', origin: 'student', why: 'Definition' },
    { from: 'uniform-continuity', to: 'varepsilon-delta-continuity', type: 'contrasts_with', origin: 'student', why: 'One δ for all points vs one per point' },
    { from: 'uniform-continuity', to: 'compactness-in-r', type: 'builds_upon', origin: 'student', why: 'Heine–Cantor needs compactness' },
    { from: 'taylor-serie', to: 'small-angle-approximation', type: 'related_to', origin: 'student', why: 'sin θ ≈ θ is the first Taylor term' },
    { from: 'damped-harmonic-oscillator', to: 'complex-conjugate-root', type: 'builds_upon', origin: 'student', why: 'Underdamped case' },
    { from: 'fundamental-theorem-of-calculus', to: 'antiderivative', type: 'builds_upon', origin: 'student', why: 'Evaluate via antiderivatives' },
    { from: 'mean-value-theorem', to: 'rolle-s-theorem', type: 'builds_upon', origin: 'student', why: 'MVT is a tilted Rolle' },
    { from: 'kinetic-energy', to: 'work-energy-theorem', type: 'part_of', origin: 'student', why: 'Net work = ΔKE' },
  ],
  sessions: [
    {
      id: 'brinda-guide-uniform',
      teacher: 'guide',
      daysAgo: 20,
      turns: [
        ['user', 'Is x² uniformly continuous on all of ℝ?'],
        ['assistant', 'Try it: fix ε = 1. As x grows, what happens to the δ you need?'],
        ['user', 'It shrinks to zero, so there is no single δ. Not uniformly continuous on ℝ, but it is on [0, 1] by Heine–Cantor.'],
        ['assistant', 'Precisely. And what property of [0, 1] did Heine–Cantor rely on?'],
        ['user', 'Compactness.'],
      ],
    },
    {
      id: 'brinda-philosopher-coriolis',
      teacher: 'philosopher',
      daysAgo: 30,
      turns: [
        ['user', 'Why do hurricanes spin opposite ways in each hemisphere?'],
        ['assistant', '[course] Coriolis force is −2m ω × v in a rotating frame.\n[web] Hurricanes rotate counter-clockwise in the north because air moving inward is deflected right.'],
      ],
    },
  ],
};

const chetna: PersonaScript = {
  startedDaysAgo: 820,
  coverage: ({ semesterNumber, subjectId }) => {
    const base = ({ 1: 0.96, 2: 0.93, 3: 0.9, 4: 0.86, 5: 0.55 } as Record<number, number>)[semesterNumber] ?? 0;
    return subjectId === 'astrophysics' ? base * 0.8 : base;
  },
  solidRate: 0.72,
  shakyRate: 0.002,
  voice: (concept, lesson) => `${concept}: revisited from "${lesson}" while reading around it with the Philosopher.`,
  heroes: [
    {
      key: 'band-gap',
      words: 'A range of energies with no allowed electron states. It opens at the Brillouin-zone boundary where Bragg reflection mixes the +k and −k waves.',
      stuck: "I first said the gap comes from electrons colliding with ions. The Philosopher pointed me at the nearly-free-electron picture, and now it's about standing waves. I want one more quiz before I trust it.",
      misconceptions: [
        {
          claim: 'The band gap exists because electrons collide with the ions.',
          course: 'The gap arises from Bragg reflection of electron waves in the periodic potential, not from scattering events.',
          daysAgo: 5,
        },
      ],
      quizzes: [[1, 3, 5], [2, 3, 1]],
      sessions: ['chetna-philosopher-bandgap'],
      daysAgo: 1,
    },
    {
      key: 'bloch-theorem',
      words: 'In a periodic potential, eigenstates are plane waves times a lattice-periodic function.',
      misconceptions: [
        {
          claim: 'Electrons should scatter off every ion, so metals should barely conduct.',
          course: 'Bloch states propagate through a perfect lattice without scattering; resistance comes from defects and phonons.',
          daysAgo: 20,
          resolved: true,
        },
      ],
      quizzes: [[3, 3, 15], [4, 4, 8]],
      daysAgo: 8,
    },
    {
      key: 'moment-of-inertia-tensor',
      words: 'Moment of inertia grown up: a symmetric 3×3 tensor. Its eigenvectors are the principal axes.',
      connections: 'Ties first-semester Mechanics to Linear Algebra, because diagonalising the tensor *is* finding the principal axes.',
      quizzes: [[4, 4, 40], [3, 3, 25]],
      daysAgo: 25,
    },
    {
      key: 'normal-mode',
      words: 'A pattern where every part oscillates at the same frequency. They are the eigenvectors of the coupled system.',
      quizzes: [[3, 3, 50], [4, 4, 30]],
      daysAgo: 30,
    },
    {
      key: 'dirac-cone',
      words: 'In graphene the bands touch at K points and disperse linearly, so the electrons act like massless particles.',
      connections: 'Read a review on 2D materials with the Philosopher. It links the honeycomb lattice from Solid State to the tight-binding model here.',
      sessions: ['chetna-philosopher-graphene'],
      quizzes: [[3, 3, 12], [3, 3, 6]],
      daysAgo: 6,
    },
    {
      key: 'newton-s-second-law',
      words: 'F = dp/dt, and later the Lagrangian made this feel like just one special case.',
      quizzes: [[3, 3, 800], [4, 4, 700], [3, 3, 300]],
      daysAgo: 300,
    },
    {
      key: 'fermi-dirac-distribution',
      words: 'Occupation of a state at energy E: 1/(e^{(E−μ)/kT} + 1). At T = 0 it is a step function at the Fermi energy.',
      quizzes: [[4, 4, 18], [3, 3, 10]],
      daysAgo: 10,
    },
  ],
  links: [
    { from: 'moment-of-inertia-tensor', to: 'moment-of-inertia', type: 'builds_upon', origin: 'student', why: 'Scalar → tensor' },
    { from: 'principal-axes', to: 'eigenvector', type: 'related_to', origin: 'student', why: 'Principal axes are eigenvectors' },
    { from: 'normal-mode', to: 'eigenvalue', type: 'builds_upon', origin: 'student', why: 'Frequencies² are eigenvalues' },
    { from: 'normal-mode', to: 'simple-harmonic-motion', type: 'builds_upon', origin: 'student', why: 'Each mode is an SHM' },
    { from: 'band-gap', to: 'bragg-s-law', type: 'builds_upon', origin: 'student', why: 'Gap opens at Bragg condition' },
    { from: 'band-gap', to: 'nearly-free-electron', type: 'related_to', origin: 'student', why: 'Standing waves at zone edge' },
    { from: 'bloch-theorem', to: 'periodic-potential', type: 'builds_upon', origin: 'student', why: 'Needs lattice periodicity' },
    { from: 'dirac-cone', to: 'honeycomb-lattice', type: 'builds_upon', origin: 'student', why: 'Two sublattices → cone' },
    { from: 'debye-model', to: 'specific-heat', type: 'related_to', origin: 'student', why: 'T³ law at low T' },
    { from: 'fermi-dirac-distribution', to: 'pauli-exclusion-principle', type: 'builds_upon', origin: 'student', why: 'One fermion per state' },
    { from: 'density-of-state', to: 'van-hove-singularity', type: 'related_to', origin: 'peer', why: "From Arjun's 2D DOS note" },
    { from: 'kronig-penney-model', to: 'finite-square-well', type: 'builds_upon', origin: 'peer', why: 'Shared by a classmate' },
    { from: 'quantum-tunnelling', to: 'coulomb-blockade', type: 'related_to', origin: 'peer', why: 'Peer reading list' },
    { from: 'schr-dinger-equation', to: 'eigenvalue-problem', type: 'part_of', origin: 'student', why: 'Hψ = Eψ' },
    { from: 'heisenberg-uncertainty-principle', to: 'commutator', type: 'builds_upon', origin: 'student', why: 'Robertson relation' },
    { from: 'singular-value', to: 'principal-component-analysis', type: 'part_of', origin: 'student', why: 'PCA via SVD' },
  ],
  sessions: [
    {
      id: 'chetna-philosopher-bandgap',
      teacher: 'philosopher',
      daysAgo: 5,
      turns: [
        ['user', 'Where does the band gap actually come from? I thought collisions with ions.'],
        [
          'assistant',
          '[course] In the nearly-free-electron model the gap opens at k = ±π/a, where Bragg reflection mixes the waves into two standing waves of different energy.\n[web] Kittel, ch. 7: the two standing waves pile charge on or between the ions, which splits their energies.',
        ],
        ['user', 'So it is interference, not scattering events. That changes how I think about insulators.'],
      ],
    },
    {
      id: 'chetna-philosopher-graphene',
      teacher: 'philosopher',
      daysAgo: 6,
      turns: [
        ['user', 'Why are graphene electrons called massless?'],
        ['assistant', '[course] Near the K points E = ħv_F|k|, which is linear like a photon\'s.\n[web] Castro Neto et al., "The electronic properties of graphene" (Rev. Mod. Phys. 2009).'],
      ],
    },
    {
      id: 'chetna-friend-thesis',
      teacher: 'friend',
      daysAgo: 2,
      turns: [
        ['user', 'How do I pick a thesis supervisor?'],
        ['assistant', 'Start with the department research page, then email two or three faculty with a short note on what you have read. Office hours are a good first conversation.'],
      ],
    },
  ],
};

export const PERSONA_SCRIPTS: Record<DemoPersona['id'], PersonaScript> = { ananya, brinda, chetna };
