import 'reflect-metadata';
import { Injectable } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { describe, expect, it } from 'vitest';

@Injectable()
class Greeter {
  greet(): string {
    return 'hello';
  }
}

@Injectable()
class Consumer {
  constructor(readonly greeter: Greeter) {}
}

describe('api scaffold', () => {
  it('resolves a provider injected by class, which needs decorator metadata', async () => {
    const moduleRef = await Test.createTestingModule({
      providers: [Greeter, Consumer],
    }).compile();

    const consumer = moduleRef.get(Consumer);

    expect(consumer.greeter).toBeInstanceOf(Greeter);
    expect(consumer.greeter.greet()).toBe('hello');
  });
});
