import { useMemo, useState } from 'react'
import { Badge, Group, Modal, SimpleGrid, Stack, Text, TextInput, UnstyledButton } from '@mantine/core'
import { moduleCategories, type ModuleDefinition } from '../modules/types'
import { moduleRegistry } from '../modules/registry'

type AddModuleModalProps = {
  opened: boolean
  onClose: () => void
  onAdd: (type: string) => void
}

export function AddModuleModal({ opened, onClose, onAdd }: AddModuleModalProps) {
  const [query, setQuery] = useState('')
  const normalized = query.trim().toLowerCase()
  const groups = useMemo(() => {
    return moduleCategories
      .map((category) => ({
        category,
        modules: moduleRegistry.filter((definition) => {
          if (definition.category !== category) return false
          if (!normalized) return true
          return [definition.title, definition.mantineComponent, definition.description, definition.category]
            .join(' ')
            .toLowerCase()
            .includes(normalized)
        }),
      }))
      .filter((group) => group.modules.length > 0)
  }, [normalized])

  return (
    <Modal
      opened={opened}
      onClose={onClose}
      title="Add a module"
      size="lg"
      onExitTransitionEnd={() => setQuery('')}
    >
      <Stack gap="md">
        <TextInput
          placeholder="Search Mantine components"
          value={query}
          onChange={(event) => setQuery(event.currentTarget.value)}
          data-autofocus
        />
        {groups.length === 0 ? (
          <Text size="sm" c="dimmed">
            No modules match that search.
          </Text>
        ) : (
          groups.map((group) => (
            <Stack key={group.category} gap="xs">
              <Text className="section-label">{group.category}</Text>
              <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="xs">
                {group.modules.map((definition) => (
                  <CatalogCard
                    key={definition.type}
                    definition={definition}
                    onAdd={() => {
                      onAdd(definition.type)
                      onClose()
                    }}
                  />
                ))}
              </SimpleGrid>
            </Stack>
          ))
        )}
      </Stack>
    </Modal>
  )
}

function CatalogCard({ definition, onAdd }: { definition: ModuleDefinition; onAdd: () => void }) {
  return (
    <UnstyledButton className="catalog-card" onClick={onAdd}>
      <Group justify="space-between" wrap="nowrap" gap="xs" mb={4}>
        <Text className="catalog-title mono-label" size="sm">
          {definition.title}
        </Text>
        <Badge variant="light" color={definition.kind === 'action' ? 'violet' : 'cyan'}>
          {definition.kind === 'action' ? 'Posts' : 'Reads'}
        </Badge>
      </Group>
      <Text size="xs" c="dimmed" mb={6}>
        {definition.mantineComponent}
      </Text>
      <Text size="sm">{definition.description}</Text>
    </UnstyledButton>
  )
}
