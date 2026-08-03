use crate::protocol::DiagnosticsEchoCommandIssue;
use std::collections::HashMap;

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum EchoCommandDecision {
    Executed {
        echoed: String,
    },
    Replayed {
        echoed: String,
    },
    IdempotencyConflict {
        existing_digest: String,
        received_digest: String,
    },
}

pub trait EchoExecutor {
    type Error;

    fn execute(&mut self, message: &str) -> Result<String, Self::Error>;
}

#[derive(Clone, Debug)]
struct StoredEchoResult {
    request_digest: String,
    echoed: String,
}

#[derive(Default)]
pub struct InMemoryCommandReducer {
    results_by_idempotency_key: HashMap<String, StoredEchoResult>,
}

impl InMemoryCommandReducer {
    pub fn handle_echo<E: EchoExecutor>(
        &mut self,
        command: DiagnosticsEchoCommandIssue,
        executor: &mut E,
    ) -> Result<EchoCommandDecision, E::Error> {
        let payload = command.payload;
        let idempotency_key: String = payload.idempotency_key.into();
        let request_digest: String = payload.request_digest.into();

        if let Some(stored) = self.results_by_idempotency_key.get(&idempotency_key) {
            if stored.request_digest == request_digest {
                return Ok(EchoCommandDecision::Replayed {
                    echoed: stored.echoed.clone(),
                });
            }

            return Ok(EchoCommandDecision::IdempotencyConflict {
                existing_digest: stored.request_digest.clone(),
                received_digest: request_digest,
            });
        }

        let message: String = payload.parameters.message.into();
        let echoed = executor.execute(&message)?;
        self.results_by_idempotency_key.insert(
            idempotency_key,
            StoredEchoResult {
                request_digest,
                echoed: echoed.clone(),
            },
        );

        Ok(EchoCommandDecision::Executed { echoed })
    }
}
