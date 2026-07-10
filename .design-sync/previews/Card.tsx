import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@asciidocollab/web';

export const ReviewComment = () => (
  <Card style={{ maxWidth: 380 }}>
    <CardHeader>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
        <CardTitle style={{ fontSize: 16 }}>Tighten the intro</CardTitle>
        <Badge variant="secondary">In review</Badge>
      </div>
      <CardDescription>joao commented on §2 “Getting started” · 2h ago</CardDescription>
    </CardHeader>
    <CardContent style={{ fontSize: 14, color: 'hsl(var(--muted-foreground))' }}>
      This paragraph repeats the overview. Can we cut it to one sentence and link the concepts guide instead?
    </CardContent>
    <CardFooter style={{ gap: 8 }}>
      <Button size="sm">Reply</Button>
      <Button size="sm" variant="outline">
        Resolve
      </Button>
    </CardFooter>
  </Card>
);

export const DocumentSummary = () => (
  <Card style={{ maxWidth: 380 }}>
    <CardHeader>
      <CardTitle style={{ fontSize: 18 }}>getting-started.adoc</CardTitle>
      <CardDescription>Last edited by maria · 12 min ago</CardDescription>
    </CardHeader>
    <CardContent style={{ fontSize: 14, color: 'hsl(var(--muted-foreground))' }}>
      3 open comments · 1 unresolved task · 2 collaborators online
    </CardContent>
  </Card>
);
