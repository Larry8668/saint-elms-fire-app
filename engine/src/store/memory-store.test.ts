import { MemoryObjectStore } from './memory-store';
import { objectStoreContract } from './store-contract';

objectStoreContract('memory store', () => new MemoryObjectStore());
